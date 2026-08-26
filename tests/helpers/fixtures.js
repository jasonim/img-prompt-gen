import { canonicalApprovalHash, createPendingReview } from '../../server/schemas.js'

export function makeCapture(overrides = {}) {
  return {
    recordType: 'capture',
    id: 'cap_11111111-1111-4111-8111-111111111111',
    text: '近距离高位斜俯拍',
    capturedAt: '2026-08-22T01:00:00.000Z',
    receivedAt: '2026-08-22T01:00:01.000Z',
    sourceType: 'browser_selection',
    processingStatus: 'pending_review',
    processedAt: null,
    derivedTermIds: [],
    derivedRecipeIds: [],
    ...overrides
  }
}

export function makeTerm(overrides = {}) {
  return {
    id: 'term_11111111-1111-4111-8111-111111111111',
    name: '近距离高位斜俯拍',
    category: 'camera',
    responsibility: 'camera_angle',
    sourceCaptureIds: ['cap_11111111-1111-4111-8111-111111111111'],
    review: createPendingReview(),
    createdAt: '2026-08-22T01:05:00.000Z',
    updatedAt: '2026-08-22T01:05:00.000Z',
    ...overrides
  }
}

export function approve(entity, collection) {
  const approvedAt = '2026-08-22T01:10:00.000Z'
  return {
    ...entity,
    review: {
      machine: { status: 'passed', checkedAt: approvedAt, issues: [] },
      human: {
        status: 'approved',
        approvedContentHash: canonicalApprovalHash(collection, entity),
        approvedAt,
        reviewer: 'local_user'
      }
    }
  }
}
