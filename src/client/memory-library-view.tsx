/**
 * 全部记忆视图：搜索、筛选、游标分页与列表；列表不返回正文。
 */
import type { ReactNode } from 'react'
import type { MemoryImportance } from '../browser-contract'
import type { AllViewState, MemoryPanelActions, Translate } from './memory-view-types'
import {
  DisabledNotice,
  ErrorNotice,
  ImportanceBadge,
  LoadingNotice,
  Notice,
  formatScore,
} from './memory-widgets'
import {
  COLOR_ACCENT,
  badgeRowStyle,
  badgeStyle,
  columnStyle,
  disabledButtonStyle,
  errorTextStyle,
  filterLabelStyle,
  filterRowStyle,
  hintStyle,
  inputStyle,
  itemSummaryStyle,
  itemTitleStyle,
  listButtonStyle,
  plainButtonStyle,
  rowBetweenStyle,
  selectStyle,
} from './memory-styles'

export function AllMemoriesView(props: {
  t: Translate
  state: AllViewState
  query: string
  project: string
  tag: string
  importance: MemoryImportance
  /** 详情里选中的记忆 id：列表中高亮，保持列表与详情选中态一致。 */
  selectedId?: string
  actions: MemoryPanelActions
}): ReactNode {
  const { t, state, actions, query, project, tag, importance, selectedId } = props
  const searching = query.trim() !== ''
  const filtering = project !== '' || tag !== '' || importance !== ''

  const controls = (
    <div style={columnStyle}>
      <div style={filterRowStyle}>
        <input
          type="search"
          aria-label={t('list.searchPlaceholder')}
          placeholder={t('list.searchPlaceholder')}
          style={inputStyle}
          value={query}
          onChange={(event) => actions.setQuery(event.target.value)}
        />
      </div>
      <div style={filterRowStyle}>
        <label style={filterLabelStyle}>
          <span>{t('list.filterProject')}</span>
          <select
            aria-label={t('list.filterProject')}
            style={selectStyle}
            value={project}
            onChange={(event) => actions.setProject(event.target.value)}
          >
            <option value="">{t('list.projectAll')}</option>
            {state.projects.map(([name, count]) => (
              <option key={name} value={name}>
                {name} ({count})
              </option>
            ))}
          </select>
        </label>
        <label style={filterLabelStyle}>
          <span>{t('list.filterTag')}</span>
          <select
            aria-label={t('list.filterTag')}
            style={selectStyle}
            value={tag}
            disabled={searching}
            onChange={(event) => actions.setTag(event.target.value)}
          >
            <option value="">{t('list.tagAll')}</option>
            {state.tags.map(([name, count]) => (
              <option key={name} value={name}>
                {name} ({count})
              </option>
            ))}
          </select>
        </label>
        <label style={filterLabelStyle}>
          <span>{t('list.filterImportance')}</span>
          <select
            aria-label={t('list.filterImportance')}
            style={selectStyle}
            value={importance}
            disabled={searching}
            onChange={(event) => actions.setImportance(event.target.value as MemoryImportance)}
          >
            <option value="">{t('list.importanceAll')}</option>
            <option value="important">{t('list.importanceImportant')}</option>
            <option value="trivial">{t('list.importanceTrivial')}</option>
          </select>
        </label>
      </div>
    </div>
  )

  if (state.status === 'disabled') {
    return (
      <div style={columnStyle}>
        {controls}
        <DisabledNotice t={t} />
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div style={columnStyle}>
        {controls}
        <ErrorNotice t={t} error={state.error} onRetry={actions.refresh} />
      </div>
    )
  }

  const loading = state.status === 'loading'
  return (
    <div style={columnStyle}>
      {controls}
      <div style={rowBetweenStyle}>
        <span style={hintStyle}>
          {searching
            ? t('list.searchTotal', { count: state.items.length })
            : t('list.total', { total: state.total })}
        </span>
        {searching ? <span style={hintStyle}>{t('list.searchMode')}</span> : null}
      </div>

      {loading ? <LoadingNotice t={t} /> : null}

      {!loading && state.items.length === 0 ? (
        searching || filtering ? (
          <Notice title={t('list.noHits')} description={t('list.noHitsHint')} />
        ) : (
          <Notice title={t('list.empty')} description={t('list.emptyHint')} />
        )
      ) : null}

      {state.items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-current={selectedId === item.id ? 'true' : undefined}
          style={
            selectedId === item.id ? { ...listButtonStyle, border: `.5px solid ${COLOR_ACCENT}` } : listButtonStyle
          }
          onClick={() => actions.select(item.id)}
        >
          <span style={itemTitleStyle}>{item.title !== '' ? item.title : t('list.unnamed')}</span>
          {item.summary !== '' ? <span style={itemSummaryStyle}>{item.summary}</span> : null}
          <span style={badgeRowStyle}>
            <ImportanceBadge t={t} importance={item.importance} />
            {item.project !== '' ? <span style={badgeStyle}>{item.project}</span> : null}
            {item.childCount > 0 ? (
              <span style={badgeStyle}>{t('tree.children', { count: item.childCount })}</span>
            ) : (
              <span style={badgeStyle}>{t('detail.leaf')}</span>
            )}
            {state.scored && item.score !== undefined ? (
              <span style={badgeStyle}>{t('list.score', { score: formatScore(item.score) })}</span>
            ) : null}
          </span>
        </button>
      ))}

      {state.loadMoreError !== undefined ? (
        <p style={errorTextStyle}>{t('list.loadMoreError')}</p>
      ) : null}
      {!loading && state.nextCursor !== null ? (
        <div>
          <button
            type="button"
            style={state.loadingMore ? disabledButtonStyle : plainButtonStyle}
            disabled={state.loadingMore}
            onClick={actions.loadMore}
          >
            {state.loadingMore ? t('list.loadingMore') : t('list.loadMore')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
