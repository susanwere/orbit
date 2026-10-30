# Orbit Muse worker infrastructure (ORB-72)

This Terraform module creates a **staging-first, one-task-per-execution** AWS ECS Fargate foundation in `eu-central-1`: ECR, ECS cluster/task definition, dedicated execution/task roles, CloudWatch Logs and a no-ingress security group.

**This module DOES NOT launch a worker**, create a service, or deploy a live Muse Code integration. Use an immutable image digest. Deploy the execution image separately, and invoke `ecs:RunTask` only from a trusted dispatcher after an authorized Orbit job exists. There is intentionally no permanent ECS Service.

## Prerequisites
- AWS account and Terraform >= 1.7, suitable IAM deployment credentials, and a **private** VPC subnet with a controlled egress proxy/NAT route plus ECR/CloudWatch/Secrets Manager access. Set `assignPublicIp=DISABLED` in every RunTask call.
- A production-approved, pinned container image implementing an actual job-token-scoped worker entry point, including the Muse CLI. The present API worker code is **not yet a production entry point**.
- A secret **already created** in AWS Secrets Manager containing the Meta API key. Secret ARN is input, not secret plaintext.
- A hardened runner that enforces repository/path restrictions at the filesystem level, limits GitHub and Muse egress, strips sensitive logging, and cannot access Orbit app credentials or unrelated repositories.
- An HTTPS job broker endpoint with independent authentication and idempotent claim/status APIs. This is not implemented yet.

## Review / validate
```sh
cd infra/muse-worker
terraform init -backend=false
terraform fmt -check
terraform validate
terraform plan -var-file=staging.tfvars
```

Copy `staging.tfvars.example` to an ignored `staging.tfvars` and fill nonsecret parameters through a protected CI environment or local environment. Keep Terraform remote state in an encrypted bucket with locking and restricted access; `terraform apply` is not called from the PR validation workflow.

## Security notes
- Egress restricted to port 443 is **not domain allowlisting**. The security group alone does **not** prevent access to unauthorized HTTPS hosts. Until a true VPC-level egress policy/proxy and application-level network controls are deployed and tested, **do not run untrusted Muse work**.
- Fargate isolation alone is not sufficient for allowlisted file access. Implement a restricted checkout or mandatory allowlist enforcement before granting a GitHub App installation token.
- The ECS execution role reads *only* the specified Meta secret. The task role intentionally has no broad AWS access.
- CloudWatch logs must be sanitized at the worker process; do not log prompts, keys or repository files.
- The Terraform variable `worker_image` is a digest, not `:latest`. ECR is immutable; image publishing will need a separately reviewed deployment pipeline.
- `ORBIT_MUSE_ISOLATED_WORKER=true` is a feature gate, not proof of OS isolation.
- Configure cost budget alerts and max concurrent `RunTask` executions before enabling dispatch.
