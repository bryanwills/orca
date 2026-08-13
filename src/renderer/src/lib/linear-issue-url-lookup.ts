import { linearStatus } from '@/runtime/runtime-linear-client'
import {
  findLinearIssueWorkspaceIdFromStatus,
  isLinearIssueUrlResolutionMatch,
  type LinearIssueUrlIntent
} from '../../../shared/linear-links'
import type { LinearConnectionStatus, LinearIssue } from '../../../shared/types'
import type { TaskSourceContext } from '../../../shared/task-source-context'

type FetchLinearIssue = (
  identifier: string,
  workspaceId?: string | null,
  options?: { sourceContext?: TaskSourceContext | null }
) => Promise<LinearIssue | null>

async function fetchMatchingLinearIssue(
  intent: LinearIssueUrlIntent,
  workspaceId: string,
  sourceContext: TaskSourceContext | null,
  fetchLinearIssue: FetchLinearIssue
): Promise<LinearIssue | null> {
  try {
    const issue = await fetchLinearIssue(intent.identifier, workspaceId, { sourceContext })
    return issue && isLinearIssueUrlResolutionMatch(intent, issue) ? issue : null
  } catch {
    return null
  }
}

export async function lookupLinearIssueUrl({
  intent,
  knownStatus,
  sourceContext,
  fetchLinearIssue,
  readLinearStatus = linearStatus
}: {
  intent: LinearIssueUrlIntent
  knownStatus: Pick<
    LinearConnectionStatus,
    'workspaces' | 'viewer' | 'activeWorkspaceId' | 'selectedWorkspaceId'
  >
  sourceContext: TaskSourceContext | null
  fetchLinearIssue: FetchLinearIssue
  readLinearStatus?: (sourceContext: TaskSourceContext | null) => Promise<LinearConnectionStatus>
}): Promise<LinearIssue | null> {
  const knownWorkspaceId = findLinearIssueWorkspaceIdFromStatus(intent, knownStatus)
  if (knownWorkspaceId) {
    const knownIssue = await fetchMatchingLinearIssue(
      intent,
      knownWorkspaceId,
      sourceContext,
      fetchLinearIssue
    )
    if (knownIssue) {
      return knownIssue
    }
  }

  const currentStatus = await readLinearStatus(sourceContext).catch(() => null)
  const currentWorkspaceId = currentStatus
    ? findLinearIssueWorkspaceIdFromStatus(intent, currentStatus)
    : null
  if (!currentWorkspaceId || currentWorkspaceId === knownWorkspaceId) {
    return null
  }
  return fetchMatchingLinearIssue(intent, currentWorkspaceId, sourceContext, fetchLinearIssue)
}
