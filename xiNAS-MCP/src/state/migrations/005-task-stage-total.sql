-- 005: the number of executor stages a task will run.
--
-- The agent sends it on the `accepted` progress event (it is the only party
-- that knows the executor's stage list); the api renders "stage N of M" from
-- it. NULL for every task created before this migration and for any task whose
-- agent predates the field — consumers must treat the denominator as optional.
ALTER TABLE tasks ADD COLUMN stage_total INTEGER;
