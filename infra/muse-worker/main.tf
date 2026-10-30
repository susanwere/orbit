terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Application = "orbit"
      Component   = "muse-worker"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

variable "aws_region" {
  type = string
  default = "eu-central-1"
}
variable "environment" {
  type = string
  default = "staging"
}
variable "name_prefix" {
  type = string
  default = "orbit-muse"
}
variable "vpc_id" { type = string }
variable "private_subnet_ids" {
  type = list(string)
  validation {
    condition     = length(var.private_subnet_ids) >= 1
    error_message = "At least one private subnet is required."
  }
}
variable "worker_image" {
  type        = string
  description = "Optional immutable ECR image digest; omit during initial ECR bootstrap." 
  default = null 
  nullable = true
  validation {
    condition     = var.worker_image == null || can(regex("@sha256:[a-f0-9]{64}$", var.worker_image))
    error_message = "Pin the worker image by sha256 digest."
  }
}
variable "meta_api_key_secret_arn" {
  type        = string
  sensitive   = true
  description = "ARN of an existing Secrets Manager secret (created out of band)."
}
variable "job_api_endpoint" {
  type        = string
  description = "HTTPS endpoint for the worker to fetch one authorized job and report results."
  validation {
    condition     = startswith(var.job_api_endpoint, "https://")
    error_message = "Only HTTPS job API endpoints are supported."
  }
}

data "aws_caller_identity" "current" {}

resource "aws_ecr_repository" "worker" {
  name                 = "${var.name_prefix}-${var.environment}"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "AES256" }
}
resource "aws_ecr_lifecycle_policy" "worker" {
  repository = aws_ecr_repository.worker.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Expire untagged images after seven days"
      selection = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 7 }
      action = { type = "expire" }
    }]
  })
}
resource "aws_cloudwatch_log_group" "worker" {
  name              = "/orbit/muse/${var.environment}"
  retention_in_days = 14
}
resource "aws_ecs_cluster" "worker" {
  name = "${var.name_prefix}-${var.environment}"
  setting {
    name = "containerInsights"
    value = "enabled"
  }
}
resource "aws_security_group" "worker" {
  name_prefix = "${var.name_prefix}-${var.environment}-"
  description = "No inbound ports; outbound TLS only; egress proxy required"
  vpc_id      = var.vpc_id
  egress {
    description = "TLS to approved endpoints through controlled egress"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  lifecycle { create_before_destroy = true }
}

data "aws_iam_policy_document" "assume_tasks" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}
resource "aws_iam_role" "execution" {
  name_prefix        = "${var.name_prefix}-execution-"
  assume_role_policy = data.aws_iam_policy_document.assume_tasks.json
}
resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
data "aws_iam_policy_document" "worker_secret" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.meta_api_key_secret_arn]
  }
}
resource "aws_iam_role_policy" "worker_secret" {
  name   = "read-specific-meta-api-secret"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.worker_secret.json
}
resource "aws_iam_role" "task" {
  name_prefix        = "${var.name_prefix}-task-"
  assume_role_policy = data.aws_iam_policy_document.assume_tasks.json
}
resource "aws_ecs_task_definition" "worker" {
  count = var.worker_image == null ? 0 : 1
  family                   = "${var.name_prefix}-${var.environment}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "2048"
  memory                   = "4096"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  ephemeral_storage { size_in_gib = 21 }
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture = "X86_64"
  }
  container_definitions = jsonencode([{
    name      = "muse-worker"
    image     = var.worker_image
    essential = true
    readonlyRootFilesystem = true
    user = "10001:10001"
    environment = [
      { name = "ORBIT_MUSE_ISOLATED_WORKER", value = "true" },
      { name = "ORBIT_JOB_API_ENDPOINT", value = var.job_api_endpoint }
    ]
    secrets = [{ name = "META_API_KEY", valueFrom = var.meta_api_key_secret_arn }]
    mountPoints = [{ sourceVolume = "scratch", containerPath = "/workspace", readOnly = false }]
    linuxParameters = { initProcessEnabled = true }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.worker.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "task"
      }
    }
  }])
  volume { name = "scratch" }
}

output "cluster_arn" { value = aws_ecs_cluster.worker.arn }
output "task_definition_arn" { value = try(aws_ecs_task_definition.worker[0].arn, null) }
output "worker_security_group_id" { value = aws_security_group.worker.id }
output "private_subnet_ids" { value = var.private_subnet_ids }
output "ecr_repository_url" { value = aws_ecr_repository.worker.repository_url }
