# Security Policy

## Supported Versions

The following table indicates the versions of the project currently receiving security updates:

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0.0 | :x:                |

## Reporting a Vulnerability

We take the security of this transactional Antigravity orchestration harness seriously. If you discover or suspect a security vulnerability, please report it privately.

**Do not report security vulnerabilities via public GitHub issues, public pull requests, or discussions.**

### Private Reporting Mechanism

Please report all vulnerabilities privately through **GitHub Security Advisories**:

1. Navigate to the repository's **Security** tab.
2. Select **Advisories** under "Vulnerability reporting".
3. Click **Report a vulnerability** to open a private advisory draft.

This ensures that the discussion, triage, and resolution remain confidential until a fix and public advisory are ready.

### Evidence to Include

To help us assess and address the issue efficiently, please include as much of the following information as possible:

* **Summary**: A clear and concise description of the potential vulnerability.
* **Component & Scope**: Affected sub-packages, modules, or skills (e.g., `@dedsec-terminal/agy-mcp-server`, worktree isolation routines, lease management, ledger outbox).
* **Reproduction Steps**: Step-by-step instructions or minimal, reproducible code samples demonstrating the vulnerability.
* **Impact Assessment**: Explanation of the potential impact, attack vectors, or failure scenarios (such as privilege escalation, path traversal, or secret leakage).
* **Environment**: Node.js version, operating system, and relevant configuration details.
* **Proposed Remediation**: Any suggested patches or mitigation steps, if identified.

### Response Targets

* **Initial Acknowledgment**: Our goal is to acknowledge receipt of new vulnerability reports within **48 to 72 business hours**. Please note that this is an operational goal rather than an absolute guarantee or contractual SLA.
* **Triage & Updates**: Following acknowledgment, maintainers will work to validate the vulnerability and provide periodic status updates within the private advisory as triage, fix development, and release planning progress.

### Responsible Disclosure & Exploit Restrictions

To safeguard users and environments running this harness:

* **Public exploit details for unpatched issues are strictly forbidden.** Do not release exploit code, proof-of-concept scripts, or actionable exploit instructions publicly before an official patch has been published.
* Maintainers will coordinate a mutually agreed public disclosure timeline once a fix is verified and released.
