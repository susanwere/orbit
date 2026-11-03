import { useEffect, useId, useRef, useState } from "react";
import type { ProjectIntentApi } from "../intent/intent-api.js";
import type { ConnectedRepository } from "../projects/project-api.js";
import "./agent-authorization-modal.css";

export async function authorizeExecutionAgent(
  api: Pick<ProjectIntentApi, "onboardMuse">,
  projectId: string,
  repository: string,
  acknowledged: boolean,
): Promise<void> {
  if (!acknowledged || !repository.trim())
    throw new Error("Choose a repository and authorize Muse Code before continuing.");
  await api.onboardMuse(projectId, repository.trim());
}

export function AgentAuthorizationModal({
  api,
  projectId,
  workItemTitle,
  onClose,
  onAuthorized,
}: {
  readonly api: Pick<ProjectIntentApi, "getRepositories" | "connectRepository" | "onboardMuse">;
  readonly projectId: string;
  readonly workItemTitle: string;
  readonly onClose: () => void;
  readonly onAuthorized: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pendingRef = useRef(false);
  const titleId = useId();
  const descriptionId = useId();
  const repositoryInputId = useId();
  const repositorySelectId = useId();
  const [repositories, setRepositories] = useState<readonly ConnectedRepository[]>([]);
  const [selectedRepository, setSelectedRepository] = useState("");
  const [repositoryInput, setRepositoryInput] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
    };
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void api
      .getRepositories(projectId)
      .then((connectedRepositories) => {
        if (!active) return;
        setRepositories(connectedRepositories);
        setSelectedRepository(
          connectedRepositories.length === 1 ? connectedRepositories[0]!.full_name : "",
        );
      })
      .catch((cause) => {
        if (active)
          setError(cause instanceof Error ? cause.message : "Could not load project repositories.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, projectId, loadAttempt]);
  async function connectRepository() {
    if (pendingRef.current || !repositoryInput.trim()) return;
    pendingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const repository = await api.connectRepository(projectId, repositoryInput.trim());
      setRepositories((current) => [
        ...current.filter((existing) => existing.id !== repository.id),
        repository,
      ]);
      setSelectedRepository(repository.full_name);
      setAcknowledged(false);
      setRepositoryInput("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect repository.");
    } finally {
      pendingRef.current = false;
      setBusy(false);
    }
  }
  async function authorize() {
    if (pendingRef.current || loading) return;
    pendingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await authorizeExecutionAgent(api, projectId, selectedRepository, acknowledged);
      onAuthorized();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not authorize Muse Code.");
    } finally {
      pendingRef.current = false;
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialogRef}
      className="agent-authorization-modal"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        if (!pendingRef.current) onClose();
      }}
    >
      <div className="agent-authorization-heading">
        <span aria-hidden="true">✦</span>
        <button type="button" aria-label="Close authorization" disabled={busy} onClick={onClose}>
          ×
        </button>
      </div>
      <h2 id={titleId}>Authorize Muse Code</h2>
      <p id={descriptionId}>
        Choose the repository Muse Code can work in before executing{" "}
        <strong>{workItemTitle}</strong>.
      </p>
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button
            type="button"
            className="orbit-detail-back"
            disabled={busy || loading}
            onClick={() => {
              setAcknowledged(false);
              setLoadAttempt((attempt) => attempt + 1);
            }}
          >
            Reload repositories
          </button>
        </div>
      )}
      {loading ? (
        <p role="status">Loading project repositories…</p>
      ) : (
        <>
          <label htmlFor={repositorySelectId}>Repository for Muse Code</label>
          <select
            id={repositorySelectId}
            value={selectedRepository}
            disabled={busy || !repositories.length}
            onChange={(event) => {
              setSelectedRepository(event.target.value);
              setAcknowledged(false);
            }}
          >
            <option value="">Select repository</option>
            {repositories.map((repository) => (
              <option key={repository.id} value={repository.full_name}>
                {repository.full_name}
              </option>
            ))}
          </select>
          <details className="agent-connect-repository" open={!repositories.length}>
            <summary>Connect a GitHub repository</summary>
            <label htmlFor={repositoryInputId}>Repository (owner/name)</label>
            <div>
              <input
                id={repositoryInputId}
                value={repositoryInput}
                disabled={busy}
                onChange={(event) => setRepositoryInput(event.target.value)}
                placeholder="owner/repository"
              />
              <button
                type="button"
                disabled={busy || !repositoryInput.trim()}
                onClick={() => void connectRepository()}
              >
                Connect
              </button>
            </div>
          </details>
          <label className="agent-authorization-consent">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={busy || !selectedRepository}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span>
              I authorize Muse Code to work in {selectedRepository || "the selected repository"} for
              this project.
            </span>
          </label>
          <p className="agent-authorization-note">
            Local execution currently supports susanwere/private-test. Other repositories can be
            authorized, but cannot run on this local worker yet.
          </p>
        </>
      )}
      <div className="agent-authorization-actions">
        <button type="button" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="workflow-execute"
          disabled={loading || busy || !selectedRepository || !acknowledged}
          onClick={() => void authorize()}
        >
          {busy ? "Working…" : "Authorize & execute"}
        </button>
      </div>
    </dialog>
  );
}
