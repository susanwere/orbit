import type { ProjectKnowledgeSnapshot } from "../intent/intent-api.js";

export interface KnowledgeChanges {
  summaryChanged: boolean;
  architectureChanged: boolean;
  addedFeatures: string[];
  removedFeatures: string[];
  addedConstraints: string[];
  removedConstraints: string[];
  addedUnknowns: string[];
  resolvedUnknowns: string[];
  changedRepositories: string[];
  changedDocuments: string[];
}

export function compareKnowledgeVersions(
  proposed: ProjectKnowledgeSnapshot,
  approved?: ProjectKnowledgeSnapshot,
): KnowledgeChanges {
  const previous = approved?.content;
  const current = proposed.content;
  const added = (next: readonly string[], before: readonly string[]) =>
    next.filter((item) => !before.includes(item));
  const old = previous?.summary;
  const repositories = new Map((previous?.repositories ?? []).map((repo) => [repo.fullName, repo]));
  const documents = new Map((previous?.documents ?? []).map((doc) => [doc.id, doc]));
  return {
    summaryChanged: current.summary.summary !== (old?.summary ?? ""),
    architectureChanged:
      current.summary.architecture !== (old?.architecture ?? "") ||
      JSON.stringify(current.summary.architectureDetails ?? null) !==
        JSON.stringify(old?.architectureDetails ?? null),
    addedFeatures: added(current.summary.features, old?.features ?? []),
    removedFeatures: added(old?.features ?? [], current.summary.features),
    addedConstraints: added(current.summary.constraints, old?.constraints ?? []),
    removedConstraints: added(old?.constraints ?? [], current.summary.constraints),
    addedUnknowns: added(current.summary.unknowns, old?.unknowns ?? []),
    resolvedUnknowns: added(old?.unknowns ?? [], current.summary.unknowns),
    changedRepositories: current.repositories
      .filter((repo) => {
        const before = repositories.get(repo.fullName);
        return !before || before.commitSha !== repo.commitSha;
      })
      .map((repo) => repo.fullName),
    changedDocuments: current.documents
      .filter((doc) => {
        const before = documents.get(doc.id);
        return !before || before.sha256 !== doc.sha256 || before.version !== doc.version;
      })
      .map((doc) => doc.filename),
  };
}
