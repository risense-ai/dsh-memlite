/**
 * 本次对话视图：回合分组、真实注入原文、逐条阈值/预算解释与显式反馈。
 */
import type { ReactNode } from 'react'
import type {
  MemoryRecallStatus,
  MemorySessionRecall,
  MemorySessionRecallsResponse,
  MemorySkipReason,
} from '../browser-contract'
import type { MemoryPanelActions, SessionViewState, Translate } from './memory-view-types'
import {
  DisabledNotice,
  ErrorNotice,
  LoadingNotice,
  Notice,
  formatScore,
  formatTimestamp,
} from './memory-widgets'
import {
  badgeRowStyle,
  badgeStyle,
  cardStyle,
  columnStyle,
  contentStyle,
  errorBadgeStyle,
  errorTextStyle,
  hintStyle,
  injectedBadgeStyle,
  itemTitleStyle,
  linkButtonStyle,
  listButtonStyle,
  plainButtonStyle,
  rowBetweenStyle,
  sectionTitleStyle,
  tabActiveStyle,
} from './memory-styles'

interface RecallGroup {
  turn: number
  entries: MemorySessionRecall[]
}

/** 按 turn 倒序分组（同 turn 内按时间倒序）。 */
function groupRecalls(entries: readonly MemorySessionRecall[]): RecallGroup[] {
  const sorted = [...entries].sort((a, b) => b.turn - a.turn || b.timestamp - a.timestamp)
  const groups: RecallGroup[] = []
  for (const entry of sorted) {
    const last = groups[groups.length - 1]
    if (last !== undefined && last.turn === entry.turn) last.entries.push(entry)
    else groups.push({ turn: entry.turn, entries: [entry] })
  }
  return groups
}

const RECALL_STATUS_TONE: Record<MemoryRecallStatus, 'muted' | 'injected' | 'error'> = {
  ok: 'injected',
  empty: 'muted',
  skipped: 'muted',
  error: 'error',
}

function SkipReasonBadge(props: { t: Translate; reason: MemorySkipReason }): ReactNode {
  const { t, reason } = props
  return <span style={badgeStyle}>{t(`session.skip.${reason}`)}</span>
}

function SessionHitBadge(props: { t: Translate; hit: MemorySessionRecallsResponse['entries'][number]['hits'][number] }): ReactNode {
  const { t, hit } = props
  if (hit.injected) return <span style={injectedBadgeStyle}>{t('session.injected')}</span>
  if (hit.exclusion === 'threshold') return <span style={badgeStyle}>{t('session.threshold')}</span>
  if (hit.exclusion === 'budget') return <span style={badgeStyle}>{t('session.budget')}</span>
  // 候选命中且没有任何注入原因：明确标注“未注入”，不得显示为已使用。
  return <span style={badgeStyle}>{t('session.candidate')}</span>
}

export function SessionView(props: {
  t: Translate
  state: SessionViewState
  feedbackBusy?: string
  actions: MemoryPanelActions
}): ReactNode {
  const { t, state, actions, feedbackBusy } = props
  if (state.status === 'unavailable') {
    return (
      <Notice
        title={t('session.unavailableTitle')}
        description={t('session.unavailableDescription')}
      />
    )
  }
  if (state.status === 'loading') return <LoadingNotice t={t} />
  if (state.status === 'disabled') return <DisabledNotice t={t} />
  if (state.status === 'error') {
    return <ErrorNotice t={t} error={state.error} onRetry={actions.refresh} />
  }

  const data = state.data
  if (data === undefined) return <Notice title={t('state.errorGeneric')} />
  if (data.entries.length === 0) {
    return <Notice title={t('session.empty')} description={t('session.emptyHint')} />
  }

  const groups = groupRecalls(data.entries)
  return (
    <div style={columnStyle}>
      <div style={rowBetweenStyle}>
        <span style={hintStyle}>
          {data.scope === 'agent' ? t('session.scopeAgent') : t('session.scopeSession')} ·{' '}
          {t('session.count', { count: data.entries.length })}
        </span>
        <span style={hintStyle}>
          {formatTimestamp(
            data.entries.reduce((latest, entry) => Math.max(latest, entry.timestamp), 0),
          )}
        </span>
      </div>
      {data.trimmed ? <p style={hintStyle}>{t('session.trimmed', { count: data.entries.length })}</p> : null}
      {groups.map((group) => (
        <div key={`turn-${group.turn}`} style={columnStyle}>
          <p style={sectionTitleStyle}>{t('session.turn', { turn: group.turn })}</p>
          {group.entries.map((entry, entryIndex) => (
            <div key={`${entry.messageId}-${entry.turn}-${entryIndex}`} style={cardStyle}>
              <div style={badgeRowStyle}>
                <span style={RECALL_STATUS_TONE[entry.status] === 'error' ? errorBadgeStyle : badgeStyle}>
                  {t(`session.status.${entry.status}`)}
                </span>
                {entry.skipReason !== undefined ? (
                  <SkipReasonBadge t={t} reason={entry.skipReason} />
                ) : null}
                {entry.backend !== '' ? (
                  <span style={badgeStyle}>{t('session.backend', { backend: entry.backend })}</span>
                ) : null}
                {entry.fallback !== '' ? (
                  <span style={badgeStyle}>{t('session.fallback', { fallback: entry.fallback })}</span>
                ) : null}
                <span style={hintStyle}>{formatTimestamp(entry.timestamp)}</span>
              </div>
              <p style={hintStyle}>
                {t('session.injectedSummary', {
                  injected: entry.hits.filter((hit) => hit.injected).length,
                  candidates: entry.hits.length,
                  backend: entry.backend !== '' ? entry.backend : '—',
                  ms: entry.elapsedMs ?? 0,
                })}
              </p>
              {entry.status === 'error' ? <p style={errorTextStyle}>{t('session.recallError')}</p> : null}
              {entry.status !== 'error' && entry.hits.length === 0 ? (
                <p style={hintStyle}>{t('session.noHits')}</p>
              ) : null}
              {entry.injectedText !== undefined && entry.injectedText !== '' ? (
                <details>
                  <summary style={linkButtonStyle}>{t('session.injectedText')}</summary>
                  <pre style={contentStyle}>{entry.injectedText}</pre>
                </details>
              ) : entry.hits.length > 0 ? (
                <p style={hintStyle}>{t('session.noInjectedText')}</p>
              ) : null}
              {entry.hits.map((hit, hitIndex) => {
                const feedback = entry.feedback?.[hit.id]
                const busyKey = `feedback:${entry.turn}:${entry.messageId}:${hit.id}`
                const why = hit.injected
                  ? t('session.whyInjected', {
                      threshold: entry.threshold ?? 0,
                      used: entry.usedChars ?? 0,
                      budget: entry.budgetChars ?? 0,
                    })
                  : hit.exclusion === 'threshold'
                    ? t('session.whyThreshold', {
                        score: formatScore(hit.score),
                        threshold: entry.threshold ?? 0,
                      })
                    : hit.exclusion === 'budget'
                      ? t('session.whyBudget', {
                          used: entry.usedChars ?? 0,
                          budget: entry.budgetChars ?? 0,
                        })
                      : t('session.whyCandidate')
                return (
                  <div key={`${hit.id}-${hitIndex}`} style={columnStyle}>
                    <button type="button" style={listButtonStyle} onClick={() => actions.select(hit.id)}>
                      <span style={itemTitleStyle}>{hit.title !== '' ? hit.title : hit.id}</span>
                      <span style={badgeRowStyle}>
                        <SessionHitBadge t={t} hit={hit} />
                        <span style={badgeStyle}>{t('session.score', { score: formatScore(hit.score) })}</span>
                        {hit.exists ? null : <span style={errorBadgeStyle}>{t('session.deleted')}</span>}
                      </span>
                      <span style={hintStyle}>{why}</span>
                    </button>
                    <div style={badgeRowStyle}>
                      <button
                        type="button"
                        style={feedback === 'helpful' ? tabActiveStyle : plainButtonStyle}
                        disabled={feedbackBusy !== undefined}
                        onClick={() => actions.feedback(entry, hit.id, 'helpful')}
                      >
                        {t('session.helpful')}
                      </button>
                      <button
                        type="button"
                        style={feedback === 'irrelevant' ? tabActiveStyle : plainButtonStyle}
                        disabled={feedbackBusy !== undefined}
                        onClick={() => actions.feedback(entry, hit.id, 'irrelevant')}
                      >
                        {t('session.irrelevant')}
                      </button>
                      {feedbackBusy === busyKey ? <span style={hintStyle}>{t('state.loading')}</span> : null}
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
