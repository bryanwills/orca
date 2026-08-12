import { afterEach, describe, expect, it } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { RpcDispatcher } from '../dispatcher'
import { authenticatedCallerFingerprint } from '../orchestration-mutation-executor'
import { ORCHESTRATION_METHODS } from './orchestration'

describe('orchestration federation acknowledgment integrity', () => {
  let db: OrchestrationDb | undefined
  let runtime: OrcaRuntimeService | undefined

  afterEach(() => {
    runtime?.stopOrchestrationFederationRelay()
    db?.close()
  })

  it('rejects duplicate settlement sequences without acknowledging the report', async () => {
    const homeToken = 'run-home-device-token'
    const homeFingerprint = authenticatedCallerFingerprint({
      id: 'home',
      authToken: homeToken,
      method: 'orchestration.federationAck'
    })
    const dispatchId = 'ctx_duplicate_settlement_sequence'
    const taskId = 'task_duplicate_settlement_sequence'
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    db.createRemoteDispatchAttachment({
      dispatchId,
      taskId,
      homePeerFingerprint: homeFingerprint,
      protocolVersion: 3,
      runtimeEpoch: runtime.getRuntimeId(),
      mutationReceipt: {
        callerFingerprint: homeFingerprint,
        requestId: 'duplicate_settlement_attach',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'duplicate_settlement_attach_payload'
      }
    })
    db.recordRemoteAttachmentStage({ dispatchId, stage: 'input_accepted', state: 'ready' })
    const report = db.enqueueFederationRelay({
      dispatchId,
      direction: 'to_home',
      kind: 'worker_done',
      payload: JSON.stringify({
        payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
      })
    })

    await expect(
      dispatcher.dispatch({
        id: 'rpc_duplicate_settlement_sequence',
        authToken: homeToken,
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        orchestrationRequestId: 'duplicate_settlement_sequence_request',
        method: 'orchestration.federationAck',
        params: {
          dispatchId,
          throughSequence: report.sequence,
          settlements: [
            {
              sequence: report.sequence,
              lifecycle: {
                action: 'rejected',
                code: 'request_mismatch',
                reason: 'Rejected duplicate',
                authority: 'run_home'
              }
            },
            {
              sequence: report.sequence,
              lifecycle: { action: 'completed', authority: 'run_home' }
            }
          ]
        }
      })
    ).resolves.toMatchObject({ ok: false, error: { code: 'request_mismatch' } })
    expect(db.getRemoteDispatchAttachment(dispatchId)?.state).toBe('ready')
    expect(db.listPendingFederationRelay(dispatchId, 'to_home')).toHaveLength(1)
  })
})
