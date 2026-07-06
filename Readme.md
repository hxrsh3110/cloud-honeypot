# Architecture Overview
This project utilizes a lightweight, containerized approach to capture unauthorized access attempts using a simulated SSH service.

## Cloud Infrastructure
Hosted on an AWS EC2 t2.micro instance running Ubuntu 24.04 LTS. Security groups are configured to strictly limit administrative SSH (Port 22) to a dedicated IP address, while leaving the honeypot listener (Port 2222) open to the public internet.

## Containerization 
The environment is isolated using Docker. It is built upon a minimal node:alpine image and runs in detached mode, safely mapping the exposed port 2222 from the host into the container.  

## Application Logic 
A custom Node.js TCP server acts as the trap. When an automated scanner or attacker connects to port 2222, the application captures their IP address and appends it with a timestamp to a local threat-logs.txt file. It then serves a fake Ubuntu login banner to stall the attacker before terminating the connection after two seconds to conserve server memory and resources.

## Data Extraction 
Threat intelligence is extracted directly from the container logs or the generated text file, allowing administrators to parse, sort, and identify the most frequent offending IP addresses.  

## Deployment Runbook

### Phase 1: AWS Infrastructure Provisioning
1.	Log into AWS Console -> EC2 -> Launch Instance.
2.	OS: Ubuntu 24.04 LTS.
3.	Instance Type: t2.micro.
4.	Key Pair: Select existing xyz-server-key. (If the key pair does not  exist, then click on create new key pair )
5.	Network / Security Group:
   	Rule 1: SSH | Port 22 | Source: My IP (Admin Access).
   	Rule 2: Custom TCP | Port 2222 | Source: Anywhere - 0.0.0.0/0 (Honeypot Trap).
6.	Click Launch. Copy the new Public IPv4 Address.

### Phase 2: Perimeter Access
1.	Open local Ubuntu WSL terminal.
2.	Ensure the private key has strict permissions (only required once per machine):
chmod 400 ~/.ssh/xyz-server-key.pem
3.	Establish the secure tunnel:
ssh -i ~/.ssh/xyz-server-key.pem ubuntu@<NEW_AWS_PUBLIC_IP>

### Phase 3: Server Prep & Deployment
1.	Update package manager and install dependencies:
sudo apt update && sudo apt install docker.io git -y
2.	Pull the codebase to the cloud:
git clone <YOUR_GITHUB_REPO_URL>

cd cloud-honeypot

3.	Build the container image:
sudo docker build -t threat-honeypot .

4.	Execute the trap (Detached mode + Port mapping):
sudo docker run -d --name live-trap -p 2222:2222 threat-honeypot

### Phase 4: Threat Verification & Extraction
1.	Verify the container is running and listening:
sudo docker logs live-trap
2.	Extract and parse attacker IP data from the container:
sudo docker exec live-trap cat threat-logs.txt | grep -oE "\b([0-9]{1,3}\.){3}[0-9]{1,3}\b" | sort | uniq -c | sort -nr
 

