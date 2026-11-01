/** Identifiers are a closed set supplied by trusted repository queries. */
export function missingRevisionFeedbackSql(sessionAlias: "s" | "session"): string {
  return `EXISTS (
    SELECT 1 FROM (
      SELECT evidence.summary,evidence.result,evidence.metadata FROM evidence
      WHERE evidence.project_id=${sessionAlias}.project_id AND evidence.organization_id=${sessionAlias}.organization_id
        AND evidence.scope_type='workflow_step' AND evidence.scope_id=step.id
        AND evidence.category='human_review' AND evidence.metadata->>'planRevision'=step.plan_revision::text
      ORDER BY evidence.created_at DESC,evidence.id DESC LIMIT 1
    ) feedback WHERE feedback.result='FAILED' AND feedback.metadata->>'decision'='rejected'
      AND CASE WHEN feedback.metadata->>'repairSourceJobId' IS NOT NULL THEN
        (${sessionAlias}.repair_source_job_id IS DISTINCT FROM feedback.metadata->>'repairSourceJobId' OR strpos(${sessionAlias}.mission,'Human-authorized CI repair: ' || feedback.summary)=0)
        ELSE strpos(${sessionAlias}.mission,'Requested human revision (not approval): ' || feedback.summary)=0 END
  )`;
}
