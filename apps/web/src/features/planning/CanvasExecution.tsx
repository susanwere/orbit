import { useCallback, useEffect, useState } from "react";
import type { ProjectIntentApi, ProjectTask, ApprovedAgent } from "../intent/intent-api.js";
import type { ConnectedRepository } from "../projects/project-api.js";
import { TaskList } from "../intent/TaskList.js";

/** Authorized task execution inside the project canvas. No implicit execution on mount. */
export function CanvasExecution({ api, projectId }: { api: ProjectIntentApi; projectId: string }) {
  const [tasks, setTasks] = useState<readonly ProjectTask[]>([]);
  const [agents, setAgents] = useState<readonly ApprovedAgent[]>([]);
  const [repositories, setRepositories] = useState<readonly ConnectedRepository[]>([]);
  const [agentId, setAgentId] = useState("");
  const [repositoryInput, setRepositoryInput] = useState("");
  const [repositoryToAuthorize, setRepositoryToAuthorize] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const [currentTasks, currentAgents, currentRepos] = await Promise.all([
      api.getTasks(projectId), api.getApprovedAgents(projectId), api.getRepositories(projectId),
    ]);
    setTasks(currentTasks);
    setAgents(currentAgents);
    setRepositories(currentRepos);
    setAgentId((current) =>
      currentAgents.some((agent) => agent.id === current)
        ? current
        : currentAgents.find((agent) => agent.provider.toLowerCase() === "meta")?.id ?? "",
    );
    setRepositoryToAuthorize((current) => current || currentRepos[0]?.full_name || "");
  }, [api, projectId]);
  useEffect(() => {
    let active = true;
    void refresh().catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : "Could not load execution.");
    });
    return () => { active = false; };
  }, [refresh]);
  async function connectRepository() {
    if (!repositoryInput.trim()) return;
    setBusy(true); setError(null);
    try {
      const connected = await api.connectRepository(projectId, repositoryInput.trim());
      setRepositoryToAuthorize(connected.full_name);
      setRepositoryInput("");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect repository.");
    } finally { setBusy(false); }
  }
  async function authorizeMuse() {
    if (!authorized || !repositoryToAuthorize) return;
    setBusy(true); setError(null);
    try {
      await api.onboardMuse(projectId, repositoryToAuthorize);
      await refresh();
      setAuthorized(false);
      setNotice("Muse Code authorized for the selected repository.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not authorize Muse.");
    } finally { setBusy(false); }
  }
  return (
    <section className="orbit-detail-page orbit-detail-page--canvas" aria-label="Workflow execution">
      <div className="orbit-detail-heading">
        <div><span className="orbit-detail-eyebrow">WORKFLOW / EXECUTION</span>
          <h2>Execute with Muse Code</h2>
          <p>Run approved engineering tasks, track agent progress and review GitHub PRs.</p>
        </div>
        <button type="button" className="orbit-detail-back" onClick={() => void refresh().catch((cause) => setError(String(cause)))}>Refresh</button>
      </div>
      {error && <p className="intent-error" role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="orbit-detail-card">
        <h3>Repository and agent authorization</h3>
        <label htmlFor="canvas-repository">Connect GitHub repository (owner/name)</label>
        <input id="canvas-repository" value={repositoryInput} onChange={(event) => setRepositoryInput(event.target.value)} placeholder="owner/repository" />
        <button type="button" disabled={busy || !repositoryInput.trim()} onClick={() => void connectRepository()}>Connect repository</button>
        <label htmlFor="canvas-authorize-repository">Repository for Muse</label>
        <select id="canvas-authorize-repository" value={repositoryToAuthorize} onChange={(event) => setRepositoryToAuthorize(event.target.value)}>
          <option value="">Select repository</option>
          {repositories.map((repository) => <option key={repository.id} value={repository.full_name}>{repository.full_name}</option>)}
        </select>
        <label><input type="checkbox" checked={authorized} onChange={(event) => setAuthorized(event.target.checked)} /> Authorize Muse Code to work in this repository</label>
        <button type="button" disabled={busy || !authorized || !repositoryToAuthorize} onClick={() => void authorizeMuse()}>Authorize Muse</button>
        <label htmlFor="canvas-agent">Approved coding agent</label>
        <select id="canvas-agent" value={agentId} onChange={(event) => setAgentId(event.target.value)}>
          <option value="">Select approved agent</option>
          {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} ({agent.provider})</option>)}
        </select>
      </div>
      <TaskList projectId={projectId} api={api} tasks={tasks} agentDefinitionId={agentId} onTasksChanged={setTasks} onRefresh={refresh} />
    </section>
  );
}
