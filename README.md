# Build Image

```bash
docker build -t judge .
```


# Create Container

```bash
docker run -it --privileged --name=judge judge
```

# Use Automatic Shell

```bash
sudo proxychains3 ./build.sh
```