-- Task CI repairs continue until CI is green; automatic_repairs is now only a counter.
ALTER TABLE project_tasks
  DROP CONSTRAINT project_tasks_automatic_repairs_check,
  ADD CONSTRAINT project_tasks_automatic_repairs_check CHECK (automatic_repairs >= 0);
