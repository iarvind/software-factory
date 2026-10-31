-- Where a job stopped, so a retry resumes there instead of rebuilding a merged change.
alter table work_items add column failed_stage text;
