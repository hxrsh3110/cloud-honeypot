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

The container drops root privileges and runs as the built-in `node` user (UID 1000) from the `node:20-alpine` image, via `USER node` in the Dockerfile. A process that's intentionally sitting open to the entire internet shouldn't also have root inside its own container. If something ever goes wrong in this code, or gets extended to parse more of what an attacker sends, root-in-container turns a small bug into a much bigger one.

One consequence of this that isn't obvious until you hit it: the host directory being mounted in has to be writable by UID 1000, not just by root. If you ever recreate the log directory or move it, run:

```bash
sudo chown -R 1000:1000 ~/honeypot-logs
```

If you skip this, the app won't crash, it'll just silently fail every write and print `Failed to save log.` to `docker logs` while the container looks perfectly healthy. This bit us once during setup and is the single easiest way to think this is working when it isn't.

## Image hardening

The base image is pinned to `node:20-alpine` instead of the floating `node:alpine` tag, so a rebuild months from now starts from the same major version instead of whatever "latest" happens to mean by then.

The image also strips out `npm`, `npx`, `corepack`, and `yarn` at build time. The app has zero dependencies, it only uses Node's built-in `net`, `fs`, and `path` modules, so none of that tooling is ever invoked at runtime, it's just dead weight bundled into the base image by default. Removing it isn't just cosmetic, a CI scan flagged 12 real CVEs living inside npm's own internal dependencies, none of them reachable by this app, but rather than exclude them from the scan, they're just not in the image anymore. The build also explicitly upgrades `libssl3`/`libcrypto3` at build time to pull in the current patched versions from Alpine's package repo, since a real OpenSSL CVE was flagged in the base OS layer on the first scan.

## CI: automated build and vulnerability scan

Every push to `main` triggers a GitHub Actions workflow (`.github/workflows/docker-scan.yml`) that builds the Docker image and scans it with [Trivy](https://trivy.dev). If it finds a CRITICAL or HIGH severity vulnerability, the workflow fails outright, it's a gate, not a report nobody reads.

Worth being clear about what this does and doesn't cover: it only runs when code gets pushed to GitHub. It does not run continuously against the live instance, and it does not auto-deploy anything, the rebuild and redeploy on the server is still a manual step. Its actual value shows up the next time a change gets pushed and the base image has moved on since the last build, new CVEs get caught before they ship, instead of an old, silently-stale image just running forever because nothing ever prompted a re-check.

## Infrastructure as Code

The AWS side, the security group, the EC2 instance, and the Elastic IP, is tracked in Terraform under `infra/main.tf`. This wasn't built from scratch, the infrastructure already existed from manual console setup, so it was brought under Terraform with `terraform import`, which tells Terraform "this resource already exists with this ID, track it instead of creating something new." That's a different process from the more commonly taught "write the file, then create fresh," and it's worth naming as such rather than implying otherwise.

The first `terraform plan` after importing showed real drift: the security group's actual name (`launch-wizard-7`, an AWS-generated default from the original console setup, never renamed) and description didn't match what was first written into the file, and one ingress rule had the wrong source IP entirely. That plan output would have destroyed and recreated the live security group if applied without checking it first, for the seconds in between, the instance would have had no security group at all. The file was corrected to match reality instead of applying, and `terraform plan` was re-run until it reported "No changes. Your infrastructure matches the configuration."

What this actually provides: a version-controlled, accurate description of the AWS-level infrastructure, and the ability to run `terraform plan` at any time to check whether reality has silently drifted from what's documented. What it does not yet provide: full one-command disaster recovery. If the instance were lost, Terraform could recreate the security group, instance, and Elastic IP shape, but installing Docker, cloning the repo, and building the container inside it is still a manual step, not yet folded into the Terraform config.

`infra/terraform.tfstate` and `infra/.terraform/` are gitignored and never pushed, since state files can contain sensitive detail about the real infrastructure. Only `main.tf`, `.gitignore`, and the provider lock file are meant to be committed.

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

## Pausing and resuming the project

Stopping the instance instead of terminating it keeps the disk, the docker setup, and the logs intact for less than a dollar a month in storage. With the Elastic IP attached, the public address doesn't change across a stop/start, so there's no need to touch the security group or look up a new IP each time.

**To pause:**

```bash
docker stop live-trap
# then stop the instance from the AWS console
```

Nothing else needs to change. The Elastic IP stays allocated and attached while stopped, monitoring doesn't need to be touched, it'll just go quiet since nothing's running.

**To resume**, pull the latest code before rebuilding rather than assuming what's on the server is current, especially if time has passed. This is the actual point of having CI in place, the next build pulls a fresh base image and gets scanned properly, instead of trusting an old image that hasn't been checked since it was last built:

```bash
# on AWS console: start the instance
ssh -i ~/.ssh/your-key.pem ubuntu@<ELASTIC_IP>
cd ~/Cloud-Deployed-Threat-Intelligence-Sensor
git pull origin main
docker build -t threat-honeypot .
docker stop live-trap && docker rm live-trap
docker run -d --name live-trap --restart unless-stopped \
  -p 2222:2222 \
  -v $HOME/honeypot-logs:/app/logs \
  threat-honeypot
```

Then verify, same as any deployment, don't just assume it's fine because nothing errored:

```bash
docker logs live-trap
nc <ELASTIC_IP> 2222
tail -1 ~/honeypot-logs/threat-logs.txt
```

## Known gaps

Being upfront about what's not done, instead of implying it is:

- **Terraform covers AWS resources, not what runs inside them.** The security group, instance, and Elastic IP are in code and verified against reality. Installing Docker, cloning the repo, and building the container on a fresh instance is still manual, not yet a `user_data` script or otherwise automated.
- **CI builds and scans, but doesn't deploy.** The pipeline catches vulnerabilities before they'd ship, but getting the fixed image onto the actual running instance is still a manual step.
- **Minimal interaction.** It logs a connection and an IP, nothing about attempted usernames or passwords, which is where a lot of the more interesting attacker behavior data would come from.
- **Monitoring has a real blind spot.** The health check relies on cron running at all. If cron itself dies, or the whole instance goes down, the healthchecks.io grace window still catches it eventually because silence itself is the alert condition, but there's no independent check confirming cron is alive day to day.