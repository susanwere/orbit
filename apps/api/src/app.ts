import Fastify from "fastify";
import cors from "@fastify/cors";
import { DomainError } from "@orbit/domain";
import { createDemoStore } from "./store.js";
import { proposePlanStub, type ProposedPlan } from "./planner.js";
import { ExecutionService } from "./execution.js";

export interface AppOptions {
  store?: ReturnType<typeof createDemoStore>;
}

interface PlanRecord {
  plan: ProposedPlan;
  status: "proposed" | "approved";
}

export async function buildApp(options: AppOptions = {}) {
  const store = options.store ?? createDemoStore();
  const execution = new ExecutionService(store);
  const plans = new Map<string, PlanRecord>();

  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  // Clients POST several action endpoints with a JSON content-type but no body.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_request, body, done) => {
      const text = (body as string).trim();
      if (!text) return done(null, {});
      try {
        return done(null, JSON.parse(text));
      } catch (err) {
        return done(err as Error, undefined);
      }
    },
  );

  app.setErrorHandler((error: Error, _request, reply) => {
    if (error instanceof DomainError) {
      const status = error.code === "forbidden" ? 403 : error.code === "not_found" ? 404 : 400;
      return reply.status(status).send({ error: error.code, message: error.message });
    }
    app.log.error(error);
    return reply.status(500).send({ error: "internal_error", message: "Unexpected error" });
  });

  const actor = (request: { headers: Record<string, unknown> }) => {
    const id = (request.headers["x-principal-id"] as string) ?? "usr_susan";
    const principal = store.principals.get(id);
    if (!principal) throw new DomainError("forbidden", `Unknown principal: ${id}`);
    return principal;
  };

  app.get("/health", async () => ({ status: "ok", service: "orbit-api" }));

  app.get("/demo/context", async () => ({
    organizationId: store.organizationId,
    principals: [...store.principals.values()],
    decisions: store.decisions,
    policies: store.policies,
    agentDefinitions: store.agentDefinitions,
  }));

  app.post<{ Body: { title?: string; intent?: string } }>("/initiatives", async (request, reply) => {
    const principal = actor(request);
    const intent = request.body?.intent?.trim();
    if (!intent) throw new DomainError("validation", "intent is required");
    const initiative = {
      id: `init_${Math.random().toString(36).slice(2, 10)}`,
      organizationId: store.organizationId,
      title: request.body?.title?.trim() || "Untitled initiative",
      intent,
      successCriteria: [] as string[],
      nonGoals: [] as string[],
      status: "draft" as const,
      driPrincipalId: principal.id,
      createdAt: new Date().toISOString(),
    };
    store.initiatives.set(initiative.id, initiative);
    return reply.status(201).send(initiative);
  });

  app.post<{ Params: { id: string } }>("/initiatives/:id/plan", async (request) => {
    actor(request);
    const initiative = store.initiatives.get(request.params.id);
    if (!initiative) throw new DomainError("not_found", "Initiative not found");
    const plan = proposePlanStub(store, initiative.id, initiative.intent);
    plans.set(initiative.id, { plan, status: "proposed" });
    initiative.status = "proposed";
    return plan;
  });

  app.post<{ Params: { id: string } }>("/initiatives/:id/approve-plan", async (request) => {
    actor(request);
    const record = plans.get(request.params.id);
    if (!record) throw new DomainError("not_found", "No proposed plan for initiative");
    if (record.status === "approved") throw new DomainError("invalid_state", "Plan already approved");
    const initiative = store.initiatives.get(request.params.id);
    if (!initiative) throw new DomainError("not_found", "Initiative not found");

    const createdWorkItemIds: string[] = [];
    for (const proposed of record.plan.workItems) {
      store.counters.workItem += 1;
      const workItemId = `wi_${Math.random().toString(36).slice(2, 10)}`;
      store.workItems.set(workItemId, {
        id: workItemId,
        organizationId: store.organizationId,
        initiativeId: initiative.id,
        key: `CG-${store.counters.workItem}`,
        title: proposed.title,
        description: proposed.description,
        ownerPrincipalId: initiative.driPrincipalId,
        state: "draft",
        risk: proposed.risk,
        decisionIds: proposed.decisionIds,
        createdAt: new Date().toISOString(),
      });
      createdWorkItemIds.push(workItemId);

      const workflowIds: string[] = [];
      const stepIdByTitle = new Map<string, string>();
      const pendingStepDeps: Array<{ stepId: string; titles: string[] }> = [];
      for (const wf of proposed.workflows) {
        const workflowId = `wf_${Math.random().toString(36).slice(2, 10)}`;
        workflowIds.push(workflowId);
        store.workflows.set(workflowId, {
          id: workflowId,
          organizationId: store.organizationId,
          workItemId,
          type: wf.type as never,
          title: wf.title,
          lane: wf.lane,
          state: "proposed",
          dependsOnWorkflowIds: wf.dependsOnWorkflowIndexes.map((i) => workflowIds[i] ?? ""),
          createdAt: new Date().toISOString(),
        });
        for (const step of wf.steps) {
          const stepId = `step_${Math.random().toString(36).slice(2, 10)}`;
          stepIdByTitle.set(step.title, stepId);
          pendingStepDeps.push({ stepId, titles: step.dependsOnStepTitles ?? [] });
          store.steps.set(stepId, {
            id: stepId,
            organizationId: store.organizationId,
            workflowId,
            title: step.title,
            kind: step.kind,
            state: "pending",
            requiredCapabilities: step.requiredCapabilities,
            assignedAgentDefinitionId: step.suggestedAgentDefinitionId,
            dependsOnStepIds: [],
            createdAt: new Date().toISOString(),
          });
        }
      }
      for (const pending of pendingStepDeps) {
        const stored = store.steps.get(pending.stepId);
        if (stored) {
          stored.dependsOnStepIds = pending.titles
            .map((t) => stepIdByTitle.get(t))
            .filter((x): x is string => Boolean(x));
        }
      }
      // Fix workflow dependency ids now that all workflows exist.
      proposed.workflows.forEach((wf, idx) => {
        const wfId = workflowIds[idx];
        const stored = wfId ? store.workflows.get(wfId) : undefined;
        if (stored) {
          stored.dependsOnWorkflowIds = wf.dependsOnWorkflowIndexes
            .map((i) => workflowIds[i])
            .filter((x): x is string => Boolean(x));
        }
      });
    }

    record.status = "approved";
    initiative.status = "active";
    return { initiativeId: initiative.id, status: "approved", workItemIds: createdWorkItemIds };
  });

  app.get<{ Params: { id: string } }>("/initiatives/:id", async (request) => {
    actor(request);
    const initiative = store.initiatives.get(request.params.id);
    if (!initiative) throw new DomainError("not_found", "Initiative not found");
    const workItems = [...store.workItems.values()]
      .filter((w) => w.initiativeId === initiative.id)
      .map((w) => ({
        ...w,
        workflows: [...store.workflows.values()]
          .filter((wf) => wf.workItemId === w.id)
          .map((wf) => ({
            ...wf,
            steps: [...store.steps.values()].filter((s) => s.workflowId === wf.id),
          })),
      }));
    return { initiative, plan: plans.get(initiative.id)?.plan ?? null, workItems };
  });

  app.get("/gates", async (request) => {
    actor(request);
    return { gates: [...execution.gates.values()] };
  });

  app.get("/executions", async (request) => {
    actor(request);
    return {
      executions: [...execution.executions.values()],
      events: execution.events,
    };
  });

  app.post<{ Params: { id: string } }>("/workflow-steps/:id/execute", async (request, reply) => {
    const principal = actor(request);
    const record = execution.startExecution(principal, request.params.id);
    return reply.status(201).send(record);
  });

  app.post<{ Params: { id: string }; Body: { decision?: string } }>(
    "/gates/:id/resolve",
    async (request) => {
      const principal = actor(request);
      const decision = request.body?.decision;
      if (decision !== "approved" && decision !== "rejected") {
        throw new DomainError("validation", "decision must be approved or rejected");
      }
      return execution.resolveGate(principal, request.params.id, decision);
    },
  );

  app.post<{ Body: Record<string, unknown> }>("/agent-definitions", async (request, reply) => {
    const principal = actor(request);
    const definition = execution.createAgentDefinition(principal, request.body ?? {});
    return reply.status(201).send(definition);
  });

  return app;
}
