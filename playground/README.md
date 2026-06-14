# Wairon SDD Playground & Testbed

This sandbox is set up for you to test Wairon's new Spec-Driven Development (SDD) features using our compiled build. 

You will design a **SaaS Billing & Usage Metering Gatekeeper** system.

---

## The Concept Project: "Gatekeeper SaaS"
A microservice that manages customer API access, counts usage tokens (metering), and enforces Stripe subscription access gates.

### Core Requirements
1. **API Gateway Ingress (Portal):** Receives client requests. Validates API keys and retrieves active subscription status.
2. **Usage Metering (Orchestrator + Store):** Records every request count to support usage-based billing.
3. **Stripe Adapter (Adapter):** Calls Stripe API to fetch active subscription levels.
4. **Subscription Database (Store):** Caches local subscription info (tier, status) to avoid calling Stripe on every request.

### Boundary Constraints to Test
* The **Stripe Adapter** must not write to or read from the **Usage Metering Store** directly.
* The **API Gateway Portal** cannot access the database stores directly; it must request validation via the **Access Gatekeeper Orchestrator**.
* Cyclic dependencies between the Access Gatekeeper and Billing Subsystems are prohibited.

---

## Step-by-Step Test Guide

### 1. Initialize the Playground
Navigate to this `playground` directory in your terminal and run the local Wairon build to initialize the spec tree:
```bash
node ../dist/cli/index.js init
```
*   Select **Claude Code** or **Gemini CLI** when prompted.
*   Wairon will bootstrap the `.wai/` config, default specs, and generate `.wai/phased_design.md`.

### 2. View the Completeness Dashboard
Run the status command to see your fresh 0% complete spec tree:
```bash
node ../dist/cli/index.js status
```
You should see:
```text
● System: playground (0% Complete)
```

### 3. Open a Fresh AI Agent Session
Start a new conversation with your AI agent (e.g. Claude Code or Antigravity) inside this `playground` folder. 
Because `wairon init` copied our custom skills to `.claude/` and `.gemini/skills/`, the AI will automatically load the SDD Architect, Narrative, and Auditor capabilities.

#### Tell the AI to Start Phase 2:
Copy and paste this prompt to your fresh AI agent session:
> "Let's design the Gatekeeper SaaS system. Let's read `.wai/phased_design.md` and start with Stage 2. Initialize the system vision as L0, and define the subsystems 'access-gate' and 'billing' as L1 subsystems using your MCP tools."

---

## Handy Commands to Run During the Test
*   **Check progress:** `node ../dist/cli/index.js status`
*   **Lint spec boundaries:** `node ../dist/cli/index.js validate`
*   **Show agents resolved:** `node ../dist/cli/index.js list`
