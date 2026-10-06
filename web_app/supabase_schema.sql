-- ================================================================
-- AutoMate Cloud: Bulletproof Supabase PostgreSQL Schema
-- Project: pnjoqcmqlmpnvvehkixr
-- ================================================================

-- 1. Create Scheduled Tasks Table (With Atomic Locking & Idempotency)
CREATE TABLE IF NOT EXISTS public.scheduled_tasks (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    numbers JSONB NOT NULL,
    message TEXT NOT NULL,
    schedule_time TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'prewarming', 'processing', 'completed', 'failed'
    results JSONB DEFAULT '[]'::JSONB,
    error TEXT,
    locked_at TIMESTAMPTZ,
    worker_id TEXT,
    executed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for Lightning-Fast Midnight Queue Execution
CREATE INDEX IF NOT EXISTS idx_tasks_status_schedule 
ON public.scheduled_tasks (status, schedule_time);

CREATE INDEX IF NOT EXISTS idx_tasks_device 
ON public.scheduled_tasks (device_id);

-- 2. Create Delivery History Table (With 7-Day Auto Retention)
CREATE TABLE IF NOT EXISTS public.delivery_history (
    id BIGSERIAL PRIMARY KEY,
    device_id TEXT NOT NULL,
    number TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL, -- 'sent', 'failed'
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_history_device_created 
ON public.delivery_history (device_id, created_at DESC);

-- 3. Enable Row-Level Security (RLS)
ALTER TABLE public.scheduled_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_history ENABLE ROW LEVEL SECURITY;

-- Drop legacy permissive policies if they exist
DROP POLICY IF EXISTS "Allow server full access on tasks" ON public.scheduled_tasks;
DROP POLICY IF EXISTS "Allow server full access on history" ON public.delivery_history;

-- A. Scheduled Tasks Policies:
-- 1. Service role (backend server) has administrative access for execution
CREATE POLICY "Service Role full access on tasks" 
ON public.scheduled_tasks 
FOR ALL 
TO service_role 
USING (true) 
WITH CHECK (true);

-- 2. Authenticated end users strictly access only their own tasks
CREATE POLICY "Tenant task isolation" 
ON public.scheduled_tasks 
FOR ALL 
TO authenticated 
USING (device_id = ('usr_' || auth.uid()::text)) 
WITH CHECK (device_id = ('usr_' || auth.uid()::text));

-- B. Delivery History Policies:
-- 1. Service role full access to insert & manage logs
CREATE POLICY "Service Role full access on history" 
ON public.delivery_history 
FOR ALL 
TO service_role 
USING (true) 
WITH CHECK (true);

-- 2. Authenticated end users strictly view & delete only their own history
CREATE POLICY "Tenant history isolation" 
ON public.delivery_history 
FOR ALL 
TO authenticated 
USING (device_id = ('usr_' || auth.uid()::text)) 
WITH CHECK (device_id = ('usr_' || auth.uid()::text));

-- 4. Atomic Job Lock Function (Prevents any duplicate execution at midnight)
CREATE OR REPLACE FUNCTION public.acquire_task_lock(p_task_id TEXT, p_worker_id TEXT)
RETURNS SETOF public.scheduled_tasks AS $$
BEGIN
    RETURN QUERY
    UPDATE public.scheduled_tasks
    SET status = 'processing',
        locked_at = NOW(),
        worker_id = p_worker_id
    WHERE id = p_task_id 
      AND status IN ('pending', 'prewarming')
    RETURNING *;
END;
$$ LANGUAGE plpgsql;

-- 5. Auto Cleanup Old Completed History (> 14 Days)
CREATE OR REPLACE FUNCTION public.prune_old_records()
RETURNS void AS $$
BEGIN
    DELETE FROM public.delivery_history 
    WHERE created_at < NOW() - INTERVAL '14 days';
    
    DELETE FROM public.scheduled_tasks 
    WHERE status IN ('completed', 'failed') 
      AND executed_at < NOW() - INTERVAL '14 days';
END;
$$ LANGUAGE plpgsql;

-- 6. User Feedback & Beta Review System
CREATE TABLE IF NOT EXISTS public.user_feedback (
    id BIGSERIAL PRIMARY KEY,
    device_id TEXT NOT NULL,
    user_email TEXT,
    rating INT NOT NULL DEFAULT 5,
    category TEXT DEFAULT 'general',
    comment TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_created 
ON public.user_feedback (created_at DESC);

ALTER TABLE public.user_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow anyone to submit feedback" ON public.user_feedback;
DROP POLICY IF EXISTS "Allow public read access on feedback" ON public.user_feedback;

CREATE POLICY "Service Role full access on feedback" 
ON public.user_feedback 
FOR ALL 
TO service_role 
USING (true) 
WITH CHECK (true);

CREATE POLICY "Allow submission of feedback" 
ON public.user_feedback 
FOR INSERT 
WITH CHECK (true);

-- Secure Public View (Strictly omits user_email and device_id to prevent email harvesting)
CREATE OR REPLACE VIEW public.public_feedback_reviews AS
SELECT 
    id,
    rating,
    category,
    comment,
    created_at
FROM public.user_feedback;
