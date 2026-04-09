import type { ServerWebSocket } from "bun"

export type QueueWs = ServerWebSocket<unknown>
export type BoardWsData = { projectId: string }
export type BoardWs = ServerWebSocket<BoardWsData>
export type RunLogWsData = { kind: "run_log"; runId: string }
export type RunLogWs = ServerWebSocket<RunLogWsData>

const queueSubscribers = new Set<QueueWs>()
const boardSubscribersByProject = new Map<string, Set<BoardWs>>()
const runLogSubscribersByRunId = new Map<string, Set<RunLogWs>>()

export function addQueueSubscriber(ws: QueueWs) {
  queueSubscribers.add(ws)
}

export function removeQueueSubscriber(ws: QueueWs) {
  queueSubscribers.delete(ws)
}

export function addBoardSubscriber(projectId: string, ws: BoardWs) {
  let set = boardSubscribersByProject.get(projectId)
  if (!set) {
    set = new Set()
    boardSubscribersByProject.set(projectId, set)
  }
  set.add(ws)
}

export function removeBoardSubscriber(projectId: string, ws: BoardWs) {
  const set = boardSubscribersByProject.get(projectId)
  if (!set) return
  set.delete(ws)
  if (set.size === 0) boardSubscribersByProject.delete(projectId)
}

export function broadcastQueue(msg: string) {
  for (const ws of queueSubscribers) {
    try {
      ws.send(msg)
    } catch {
      queueSubscribers.delete(ws)
    }
  }
}

export function broadcastBoard(projectId: string, msg: string) {
  const set = boardSubscribersByProject.get(projectId)
  if (!set || set.size === 0) return
  for (const ws of set) {
    try {
      ws.send(msg)
    } catch {
      set.delete(ws)
    }
  }
  if (set.size === 0) boardSubscribersByProject.delete(projectId)
}

export function addRunLogSubscriber(runId: string, ws: RunLogWs) {
  let set = runLogSubscribersByRunId.get(runId)
  if (!set) {
    set = new Set()
    runLogSubscribersByRunId.set(runId, set)
  }
  set.add(ws)
}

export function removeRunLogSubscriber(runId: string, ws: RunLogWs) {
  const set = runLogSubscribersByRunId.get(runId)
  if (!set) return
  set.delete(ws)
  if (set.size === 0) runLogSubscribersByRunId.delete(runId)
}

export function broadcastRunLog(runId: string, msg: string) {
  const set = runLogSubscribersByRunId.get(runId)
  if (!set || set.size === 0) return
  for (const ws of set) {
    try {
      ws.send(msg)
    } catch {
      set.delete(ws)
    }
  }
  if (set.size === 0) runLogSubscribersByRunId.delete(runId)
}

/**
 * Close and forget all board websocket subscribers for a project.
 * Useful when deleting a project so clients don't remain subscribed to a non-existent board.
 */
export function closeBoardSubscribers(projectId: string) {
  const set = boardSubscribersByProject.get(projectId)
  if (!set || set.size === 0) return
  for (const ws of set) {
    try {
      ws.close(1000, "Project deleted")
    } catch {
      /* ignore */
    }
  }
  boardSubscribersByProject.delete(projectId)
}

