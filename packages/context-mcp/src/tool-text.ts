/**
 * Model-facing text shared by every Zooid tool surface — the MCP server here
 * and the native pi extension ([[ZOD080]]). One copy, so both runtimes teach
 * the model the same handoff contract ([[ZOD092]] §7, [[ZOD094]]).
 * No imports: this module is inlined into the pi bundle.
 */

/** MCP server `instructions`; on pi, a promptGuidelines bullet on zooid_handoff. */
export const AGENT_NOTIFY_INSTRUCTIONS =
  'To involve another agent in this thread, call zooid_handoff. @mentions in your messages notify humans; they do not notify agents.'

export const HANDOFF_DESCRIPTION =
  'Hand work to one other agent in THIS thread — the only way to involve another agent here. @mentions in messages do not notify agents. Name the agent by name (or workstation.agent); the daemon resolves it. After a successful handoff, end your turn: the result comes back to you as `[handoff return] from <agent>`. For several agents in parallel, use zooid_start_task_threads instead.'

export const SEND_MESSAGE_DESCRIPTION =
  'Post a message into a room or thread this agent is bound to. Fire-and-forget: no assignee, no completion tracking, no notify. @mentions in it notify humans; they do not notify agents. To involve another agent use zooid_handoff (this thread) or zooid_start_task_threads (parallel, new threads).'
