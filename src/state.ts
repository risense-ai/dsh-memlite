/** 每 agent / 每 turn 的状态机（对齐 respire-dsh 的 WeakMap 状态）。 */

export interface TurnState {
  turn: number
  /** 已处理的 message.id；没有 id 的消息用对象身份去重。 */
  processed: Set<string>
  seen: WeakSet<object>
  hadUser: boolean
  stored: boolean
  reminded: boolean
}

export interface AgentState {
  /** 每 agent 一生只做一次 status 体检。 */
  checked: boolean
  /** 引擎已确认可用（成功 status / recall / store）。 */
  ready: boolean
  rounds: number
  turn?: TurnState
}

export class States {
  private readonly byAgent = new WeakMap<object, AgentState>()

  /** 取或建（agent 是对象身份，多 agent 不串味）。 */
  of(agent: object): AgentState {
    let state = this.byAgent.get(agent)
    if (!state) {
      state = { checked: false, ready: false, rounds: 0 }
      this.byAgent.set(agent, state)
    }
    return state
  }

  /** 只读查看（turn-stopping 不应为未知 agent 新建状态）。 */
  peek(agent: object): AgentState | undefined {
    return this.byAgent.get(agent)
  }

  drop(agent: object): void {
    this.byAgent.delete(agent)
  }

  /** 新 turn 的重置（保留 checked/ready/rounds）。 */
  startTurn(state: AgentState, turn: number): TurnState {
    state.rounds += 1
    state.turn = {
      turn,
      processed: new Set<string>(),
      seen: new WeakSet<object>(),
      hadUser: false,
      stored: false,
      reminded: false,
    }
    return state.turn
  }
}
