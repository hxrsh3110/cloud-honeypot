# SSH Honeypot on AWS EC2

A small Node.js TCP server that pretends to be an SSH login prompt, logs whoever connects, and keeps that log even if the container gets rebuilt or the box reboots.

This README describes what the project actually does right now, not what it might do someday. Anything not built yet is listed at the bottom under Known Gaps instead of being dressed up as done.

## What it does

The server listens on port 2222. When anything connects, it:

1. Grabs the connecting IP address and strips the `::ffff:` prefix that shows up on dual-stack listeners, so you get a clean IPv4 address in the log instead of a mangled one.
2. Logs the IP and a timestamp to `threat-logs.txt`.
3. Sends back a fake Ubuntu login banner to make it look like a real machine for a couple seconds.
4. Closes the connection after 2 seconds so it doesn't sit there using memory.

That's it. It doesn't accept a fake password, doesn't run a fake shell, and doesn't capture usernames typed after the login prompt. It's a connection logger with a believable front door, not a full interactive trap.

## Why the logs survive container restarts

Containers are throwaway by design. Anything written to a container's own filesystem disappears when the container is removed. To avoid losing data every time the app gets rebuilt or redeployed, the log file lives outside the container, on the host, and gets mounted in:

```bash
-v $HOME/honeypot-logs:/app/logs
```

The app writes to an absolute path (`/app/logs/threat-logs.txt`) that matches this mount, not a relative path that depends on whatever the working directory happens to be at runtime.

## Why it doesn't run as root

The container drops root privileges and runs as the built-in `node` user (UID 1000) from the `node:alpine` image, via `USER node` in the Dockerfile. A process that's intentionally sitting open to the entire internet shouldn't also have root inside its own container. If something ever goes wrong in this code, or gets extended to parse more of what an attacker sends, root-in-container turns a small bug into a much bigger one.

One consequence of this that isn't obvious until you hit it: the host directory being mounted in has to be writable by UID 1000, not just by root. If you ever recreate the log directory or move it, run:

```bash
sudo chown -R 1000:1000 ~/honeypot-logs
```

If you skip this, the app won't crash, it'll just silently fail every write and print `Failed to save log.` to `docker logs` while the container looks perfectly healthy. This bit us once during setup and is the single easiest way to think this is working when it isn't.

## Monitoring

A cron job runs `health-check.sh` every 5 minutes, checks whether the `live-trap` container is up, and logs the result to `~/honeypot-logs/health.log`. On every healthy check it also pings a [healthchecks.io](https://healthchecks.io) endpoint. If that ping goes silent for longer than the configured period plus grace window, healthchecks.io sends an email automatically. This is what actually closes the loop, a log file nobody reads isn't a monitor, an external service that notices your silence is.

Current settings: 10 minute period, 5 minute grace, so a real outage takes up to about 15 minutes to trigger an email. That's a deliberate tradeoff for a low-traffic honeypot, not a hard requirement, tighten it if that's too slow for your needs.

## Deployment

### 1. Launch the EC2 instance

- Ubuntu 24.04 LTS
- Allocate an Elastic IP and associate it with the instance. Without this, EC2 hands you a new public IP on every stop/start, which means re-editing your security group's SSH rule every time you restart the box. With it, the address is fixed for good.
- Security group inbound rules:
  - Port 22 (SSH), source: your IP only
  - Port 2222 (honeypot), source: anywhere

### 2. Connect and prep the server

```bash
ssh -i ~/.ssh/your-key.pem ubuntu@<PUBLIC_IP>
sudo apt update && sudo apt install docker.io git -y
```

Add your user to the `docker` group so you don't need `sudo` for every docker command:

```bash
sudo usermod -aG docker ubuntu
```

Log out and back in for that to take effect, then confirm with `groups` — you should see `docker` in the list.

### 3. Get the code and build

```bash
git clone <YOUR_REPO_URL>
cd <project-folder>
docker build -t threat-honeypot .
```

### 4. Run it

```bash
mkdir -p ~/honeypot-logs
docker run -d --name live-trap --restart unless-stopped \
  -p 2222:2222 \
  -v $HOME/honeypot-logs:/app/logs \
  threat-honeypot
```

`--restart unless-stopped` means the container comes back on its own if the instance reboots unexpectedly, without needing you to manually `docker start` it.

### 5. Verify it's actually working

Don't trust that it's fine just because `docker ps` shows it running. Actually check:

```bash
docker logs live-trap
```

Look for `Failed to save log.` — if you see it, it's a permissions problem (see above). If it's clean, trigger a real connection from a different network than the server itself is on, then confirm the log actually grew:

```bash
nc <PUBLIC_IP> 2222
cat ~/honeypot-logs/threat-logs.txt
```

## Reading the logs

Most frequent attacker IPs:

```bash
cat ~/honeypot-logs/threat-logs.txt | grep -oE "\b([0-9]{1,3}\.){3}[0-9]{1,3}\b" | sort | uniq -c | sort -nr
```

Watch it live:

```bash
tail -f ~/honeypot-logs/threat-logs.txt
```

Pull it to your local machine:

```bash
scp -i ~/.ssh/your-key.pem ubuntu@<PUBLIC_IP>:~/honeypot-logs/threat-logs.txt ./
```

## Stopping and starting to save cost

Stopping the instance instead of terminating it keeps the disk, the docker setup, and the logs intact for less than a dollar a month in storage. With the Elastic IP attached, the public address doesn't change across a stop/start, so there's no need to touch the security group or look up a new IP each time.

When resuming:

```bash
# on AWS console: start the instance
ssh -i ~/.ssh/your-key.pem ubuntu@<ELASTIC_IP>
```

The container comes back on its own thanks to `--restart unless-stopped`, but if you ever need to start it manually:

```bash
docker start live-trap
```

## Known gaps

Being upfront about what's not done, instead of implying it is:

- **No Infrastructure as Code.** The whole EC2 setup above is manual console clicking. If this instance died right now, rebuilding it means redoing every step by hand from memory. Terraform for this is the next planned piece of work, not yet started.
- **No CI/CD or image scanning.** Nothing checks this Docker image for known vulnerabilities before it gets deployed. Planned next.
- **Minimal interaction.** It logs a connection and an IP, nothing about attempted usernames or passwords, which is where a lot of the more interesting attacker behavior data would come from.
- **Monitoring has a real blind spot.** The health check relies on cron running at all. If cron itself dies, or the whole instance goes down, the healthchecks.io grace window still catches it eventually because silence itself is the alert condition, but there's no independent check confirming cron is alive day to day.
