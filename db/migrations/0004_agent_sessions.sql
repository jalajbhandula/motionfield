-- Orchestrator agent sessions: async message protocol
-- (sessions -> messages; poll with ?after=<seq>; interrupt; awaiting_input gate)
CREATE TABLE IF NOT EXISTS agent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE cascade,
  title text,
  status text NOT NULL DEFAULT 'active', -- active | awaiting_input | done | interrupted
  project_id uuid,
  context jsonb NOT NULL DEFAULT '{}',    -- planner state: plan steps, pending tool calls
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_sessions_user_idx ON agent_sessions(user_id, created_at);

CREATE TABLE IF NOT EXISTS agent_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE cascade,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  role text NOT NULL,                    -- user | assistant | tool | system
  kind text NOT NULL DEFAULT 'text',     -- text | plan | tool_call | tool_result | question | status
  content jsonb NOT NULL DEFAULT '{}',   -- {text?} | {tool,name,args?} | {steps?[]} | {question,fields?[]}
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq)
);
CREATE INDEX IF NOT EXISTS agent_messages_session_idx ON agent_messages(session_id, seq);
