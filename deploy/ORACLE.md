# Run the agent on Oracle Cloud (Always Free)

Oracle's Always Free tier includes an Arm server (up to 4 CPUs and 24 GB RAM in total) that does not expire.
Screens and limits change from time to time; if something below looks different, follow the closest option.

## 1. Create the account
1. Sign up at https://www.oracle.com/cloud/free/
2. Pick your **home region** carefully: it cannot be changed later, and free Arm servers are only in that region.
   A nearby region with spare capacity is best (for Pakistan: UAE, India or Saudi Arabia regions).
3. A card is needed to verify you. Always Free resources are not charged.

## 2. Create the server
1. Menu → **Compute → Instances → Create instance**.
2. **Image**: Canonical **Ubuntu 24.04**.
3. **Shape**: Ampere → **VM.Standard.A1.Flex**, 2 OCPUs and 12 GB memory is plenty (it must say *Always Free-eligible*).
4. **SSH keys**: "Generate a key pair" and **download the private key**. You need it to log in.
5. Create. If it says *Out of capacity*, try another availability domain or try again later.
6. Note the **Public IP address** shown on the instance page.

## 3. Open the web ports in Oracle's firewall
Instance page → **Subnet** → **Security Lists** → the default list → **Add Ingress Rules**:
- Source CIDR `0.0.0.0/0`, IP protocol TCP, destination port `80`
- Source CIDR `0.0.0.0/0`, IP protocol TCP, destination port `443`

## 4. Point a domain at it
In your DNS (Hostinger → Domains → DNS), add an **A record**:
- Name: `agent` (gives `agent.yourdomain.com`), Points to: the server's public IP.

## 5. Log in and install
On Windows, open PowerShell; on Mac/Linux, a terminal:

```bash
ssh -i path/to/ssh-key.key ubuntu@YOUR_SERVER_IP
```

On the server:

```bash
git clone https://github.com/awais-webs67/whatsapp-personal-agent.git
cd whatsapp-personal-agent
bash deploy/setup-server.sh agent.yourdomain.com
```

The repository is private, so `git clone` asks for your GitHub username and a **personal access token**
(GitHub → Settings → Developer settings → Personal access tokens) as the password.

Then open `https://agent.yourdomain.com`, set the owner password, and link your WhatsApp number.

## Everyday
- Update to the latest version: `cd ~/whatsapp-personal-agent && git pull && npm install --omit=dev && pm2 restart agent`
- See what it is doing: `pm2 logs agent`
- Back up `~/whatsapp-personal-agent/data` (chats, settings, keys), for example by downloading it with `scp`.

## Good to know
- Oracle may reclaim Always Free servers that look idle (very low CPU, network and memory use for a week).
  This agent uses little CPU. Upgrading the account to *Pay As You Go* is said to stop idle reclaiming while
  free resources stay free; check Oracle's current terms before relying on either.
- A WhatsApp number linked by QR from a data-centre IP may be watched more closely by WhatsApp than one linked from home.
- Running your own AI model (Ollama) on this server works but is slow without a graphics card; free online models
  (Groq, Gemini) are faster.
