import {
  AssignMessage,
  ConfigJson, ConfigSubtask, ConfigTaskDefault,
  DispatchTask,
  FinishMessage,
  JudgeResult,
  ProgressMessage, SubtaskResult, TaskResult,
} from "../../types/client";
import {JudgeFactory} from "./judge.factory";

/**
 * 评测机类
 */
export class Judge {
  // 支持的语言
  private readonly language: string;
  // 是否被占用
  private occupied: boolean;
  // 评测结果
  private readonly judgeResult: JudgeResult;
  // 评测状态
  private readonly judgeStatus: FinishMessage | ProgressMessage;
  // 可执行文件的id
  private execFile: string;
  // 评测任务的配置文件
  private config: ConfigJson | undefined;
  // 子任务
  private subTask: ConfigSubtask<ConfigTaskDefault>[] = [];

  constructor(language: string) {
    this.language = language;
    this.execFile = '';
    this.occupied = false;

    this.judgeResult = {
      message: '',
      status: "Pending",
      score: 0,
      subtasks: []
    };

    this.judgeStatus = {
      type: "progress",
      id: -1,
      result: this.judgeResult
    };

  }

  /**
   * 获取评测状态
   */
  public getJudgeStatus = (): FinishMessage | ProgressMessage => {
    return this.judgeStatus;
  }

  /**
   * 评测机是否有评测任务
   */
  public isOccupied = (): boolean => {
    return this.occupied;
  }

  /**
   * 评测机是否运行所有的子任务
   */
  public isAllSubTaskFinished = (): boolean => {
    if (this.subTask.length <= 0) {
      if (this.judgeResult.status === "Running") {
        this.judgeResult.status = "Accepted";
      }
      this.judgeStatus.type = "finish";
    }
    return this.subTask.length <= 0;
  }

  /**
   * 评测机是否完成配置
   */
  public isConfigured = (): boolean => {
    return this.config !== undefined;
  }

  /**
   * 重置评测机状态
   */
  public reset = () => {
    this.occupied = false;
    this.judgeResult.message = '';
    this.judgeResult.status = "Pending";
    this.judgeResult.score = 0;
    this.judgeResult.subtasks.splice(0);
    this.judgeStatus.type = "finish";
    this.judgeStatus.id = -1;
  }

  /**
   * 设置评测机的配置文件
   */
  public configure = (configJson: string) => {
    this.config = JSON.parse(configJson) as ConfigJson;
    if (this.config.type == "default") {
      this.subTask = this.config.subtasks;
    } else {
      if (process.env.RUNNING_LEVEL === "debug") {
        console.error("[judge]", "unsupported config type");
      }
    }
  }

  /**
   * 接收任务
   *
   * @param task 任务内容
   * @return 是否接取任务
   */
  public receive = (task: AssignMessage): boolean => {
    if (task.language === this.language && !this.occupied) {
      this.occupied = true;
      this.judgeResult.status = "Judging";
      this.judgeStatus.type = "progress";
      this.judgeStatus.id = task.id;
      return true;
    }
    return false;
  }

  /**
   * 执行任务1：编译代码
   *
   * @param task 任务内容
   * @return 编译的结果
   */
  public compile = async (task: AssignMessage): Promise<boolean> => {
    this.judgeResult.status = "Compiling";

    const compileTask: DispatchTask = {
      id: task.id,
      code: task.code,
      language: task.language,
      files: task.files
    };

    const output: { code: number, message: string, fileId: string } = await JudgeFactory.judge(compileTask);

    if (output.code === 1) {
      // 编译错误
      this.judgeResult.message = output.message;
      this.judgeResult.status = "Compile Error"
      this.judgeStatus.type = "finish";
      return false;
    } else if (output.code === 0) {
      // 编译成功
      this.judgeResult.message = output.message;
      this.judgeResult.status = "Running";
      this.execFile = output.fileId;
      return true;
    } else {
      // 系统错误
      this.judgeResult.message = output.message;
      this.judgeResult.status = "System Error";
      this.judgeStatus.type = "progress";
      return false;
    }
  }

  /**
   * 执行任务2：运行代码
   *
   * @param fileList 文件列表，key为uuid，value为文件内容
   * @param task
   * @return 运行的结果
   */
  public run = async (fileList: Map<string, string>, task: AssignMessage): Promise<boolean> => {
    const subtask = this.subTask[0];
    for (let i = 0; i < subtask.cases.length; ++i) {
      if (!(fileList.has(task.files[subtask.cases[i].input]) && fileList.has(task.files[subtask.cases[i].output]))) {
        return false;
      }
    }

    // 计算每一个测试点得分
    const singleScore = subtask.score / subtask.cases.length;
    // 初始化子任务运行结果
    const subtaskResult: SubtaskResult = {
      message: '',
      status: "Running",
      score: 0,
      tasks: []
    };

    // 输入文件和输出文件都存在，开始运行
    for (let i = 0; i < subtask.cases.length; ++i) {
      const input: string = fileList.get(task.files[subtask.cases[i].input]) as string;
      const output: string = fileList.get(task.files[subtask.cases[i].output]) as string;

      const result: {
        code: number,
        output: string,
        runtime: number,
        memory: number
      } = await JudgeFactory.exec(input, this.execFile, task);

      const caseResult: TaskResult = {
        message: result.output,
        status: "Running",
        time: result.runtime,
        /** 内存使用量，单位为 byte，如果没有结果则为 -1 */
        memory: result.memory,
      };

      // 检查内存和时间限制
      if (this.config?.type === "default" && this.config?.time && result.runtime > this.config?.time) {
        caseResult.status = "Time Limit Exceeded";
        subtaskResult.status = "Time Limit Exceeded";
        this.judgeResult.status = "Time Limit Exceeded";
      } else if (this.config?.type === "default" && this.config?.memory && result.memory > this.config?.memory) {
        caseResult.status = "Memory Limit Exceeded";
        subtaskResult.status = "Memory Limit Exceeded";
        this.judgeResult.status = "Memory Limit Exceeded";
      } else if (result.code === 1) {
        // runtime error
        caseResult.status = "Runtime Error";
        subtaskResult.status = "Runtime Error";
        this.judgeResult.status = "Runtime Error";
      } else if (result.code === 2) {
        if (process.env.RUNNING_LEVEL === "debug") {
          console.error("[judge]", "system error while running cases");
        }
        // system error
        caseResult.status = "System Error";
        subtaskResult.status = "System Error";
        this.judgeResult.status = "System Error";
      } else if (result.code === 0) {
        // run success, compare output
        if (!this.contrast(output, result.output)) {
          caseResult.status = "Wrong Answer";
          subtaskResult.status = "Wrong Answer";
          this.judgeResult.status = "Wrong Answer";
        } else {
          caseResult.status = "Accepted";
          subtaskResult.score += singleScore;
        }
      } else {
        // unknown error
        caseResult.status = "System Error";
        subtaskResult.status = "System Error";
        this.judgeResult.status = "System Error";
        if (process.env.RUNNING_LEVEL === "debug") {
          console.error("[judge]", "unknown error while running cases");
        }
      }

      subtaskResult.tasks.push(caseResult);
      fileList.delete(task.files[subtask.cases[i].input]);
      fileList.delete(task.files[subtask.cases[i].output]);
    }

    if (subtaskResult.status === "Running") {
      subtaskResult.status = "Accepted";
    }

    this.judgeResult.subtasks.push(subtaskResult);
    this.judgeResult.score += subtaskResult.score;

    // 删除第一个
    this.subTask.shift();

    return false;
  }

  /**
   * 执行任务3：对比答案
   *
   * @param answer 正确答案
   * @param output 输出结果
   * @return 答案是否正确
   */
  public contrast = (answer: string, output: string) => {
    // TODO 对比答案只是简单的字符串对比，后续可以添加对空格、换行符等的处理
    return answer === output;
  }
}