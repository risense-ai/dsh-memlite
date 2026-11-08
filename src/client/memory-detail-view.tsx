/**
 * 记忆详情：全文、元数据、因果邻居、完整链与写操作入口。
 */
import type { ReactNode } from 'react'
import type { DetailViewState, MemoryPanelActions, Translate } from './memory-view-types'
import {
  DisabledNotice,
  ErrorNotice,
  Notice,
  formatTimestamp,
} from './memory-widgets'
import {
  COLOR_ERROR,
  badgeRowStyle,
  badgeStyle,
  chainLinkStyle,
  chainRowStyle,
  columnStyle,
  contentStyle,
  detailCardStyle,
  errorTextStyle,
  hintStyle,
  itemSummaryStyle,
  itemTitleStyle,
  linkButtonStyle,
  metaLabelStyle,
  metaRowStyle,
  metaValueStyle,
  neighborButtonStyle,
  plainButtonStyle,
  rowBetweenStyle,
  sectionTitleStyle,
} from './memory-styles'

export function DetailView(props: {
  t: Translate
  state: DetailViewState
  copied?: 'content' | 'id' | 'failed'
  actions: MemoryPanelActions
}): ReactNode {
  const { t, state, actions, copied } = props

  const header = (
    <div style={rowBetweenStyle}>
      <p style={sectionTitleStyle}>{t('detail.title')}</p>
      <button type="button" style={linkButtonStyle} onClick={actions.closeDetail}>
        {t('detail.close')}
      </button>
    </div>
  )

  if (state.status === 'loading') {
    return (
      <div style={detailCardStyle}>
        {header}
        <p style={hintStyle}>{t('detail.loading')}</p>
      </div>
    )
  }
  if (state.status === 'disabled') {
    return (
      <div style={detailCardStyle}>
        {header}
        <DisabledNotice t={t} />
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div style={detailCardStyle}>
        {header}
        <ErrorNotice
          t={t}
          error={state.error}
          onRetry={() => {
            if (state.id !== undefined) actions.select(state.id)
          }}
        />
      </div>
    )
  }

  const data = state.data
  if (data === undefined || !data.found || data.record === undefined) {
    return (
      <div style={detailCardStyle}>
        {header}
        <Notice title={t('detail.deletedTitle')} description={t('detail.deletedDescription')} />
      </div>
    )
  }

  const record = data.record
  const copyState =
    copied === 'failed' ? (
      <span style={errorTextStyle}>{t('detail.copyFailed')}</span>
    ) : copied !== undefined ? (
      <span style={hintStyle}>{t('detail.copied')}</span>
    ) : null

  return (
    <div style={detailCardStyle}>
      {header}
      <span style={itemTitleStyle}>{record.title !== '' ? record.title : t('list.unnamed')}</span>

      <div style={columnStyle}>
        <div style={metaRowStyle}>
          <span style={metaLabelStyle}>{t('detail.metaProject')}</span>
          <span style={metaValueStyle}>{record.project !== '' ? record.project : '—'}</span>
        </div>
        <div style={metaRowStyle}>
          <span style={metaLabelStyle}>{t('detail.metaImportance')}</span>
          <span style={metaValueStyle}>
            {record.importance === 'important'
              ? t('list.importanceImportant')
              : record.importance === 'trivial'
                ? t('list.importanceTrivial')
                : t('list.importanceUnmarked')}
          </span>
        </div>
        <div style={metaRowStyle}>
          <span style={metaLabelStyle}>{t('detail.metaKind')}</span>
          <span style={metaValueStyle}>{record.kind !== '' ? record.kind : '—'}</span>
        </div>
        <div style={metaRowStyle}>
          <span style={metaLabelStyle}>{t('detail.metaTags')}</span>
          <span style={metaValueStyle}>{record.tags.length > 0 ? record.tags.join(' · ') : '—'}</span>
        </div>
        <div style={metaRowStyle}>
          <span style={metaLabelStyle}>{t('detail.metaCreated')}</span>
          <span style={metaValueStyle}>{formatTimestamp(record.ts)}</span>
        </div>
        <div style={metaRowStyle}>
          <span style={metaLabelStyle}>{t('detail.parent')}</span>
          <span style={metaValueStyle}>
            {record.parentId !== '' ? record.parentId : t('detail.noParent')}
          </span>
        </div>
        <div style={metaRowStyle}>
          <span style={metaLabelStyle}>{t('detail.metaId')}</span>
          <span
            style={{
              ...metaValueStyle,
              fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
            }}
          >
            {record.id}
          </span>
        </div>
        <div style={metaRowStyle}>
          <span style={metaLabelStyle}>{t('detail.metaChildren')}</span>
          <span style={metaValueStyle}>{record.leaf ? t('detail.leaf') : String(record.childCount)}</span>
        </div>
      </div>

      <pre style={contentStyle}>{record.content}</pre>
      {record.truncated ? <p style={hintStyle}>{t('detail.contentTruncated')}</p> : null}

      <div style={badgeRowStyle}>
        <button type="button" style={plainButtonStyle} onClick={() => actions.openEditor('edit', record)}>
          {t('detail.edit')}
        </button>
        <button type="button" style={plainButtonStyle} onClick={() => actions.openEditor('reply', record)}>
          {t('detail.reply')}
        </button>
        <button type="button" style={plainButtonStyle} onClick={() => actions.openEditor('attach', record)}>
          {t('detail.attach')}
        </button>
        <button type="button" style={plainButtonStyle} onClick={() => actions.searchAround(record.title)}>
          {t('detail.around')}
        </button>
        <button type="button" style={plainButtonStyle} onClick={() => actions.copy('content', record.content)}>
          {t('detail.copyAction')}
        </button>
        <button type="button" style={plainButtonStyle} onClick={() => actions.copy('id', record.id)}>
          {t('detail.copyIdAction')}
        </button>
        <button
          type="button"
          style={{ ...plainButtonStyle, color: COLOR_ERROR, border: `.5px solid ${COLOR_ERROR}` }}
          onClick={() => actions.openEditor('forget', record)}
        >
          {t('detail.forget')}
        </button>
        {copyState}
      </div>

      {data.ancestors.length > 0 ? (
        <div style={columnStyle}>
          <p style={sectionTitleStyle}>{t('detail.ancestors')}</p>
          {data.ancestors.map((neighbor) => (
            <button
              key={neighbor.id}
              type="button"
              style={neighborButtonStyle}
              onClick={() => actions.select(neighbor.id)}
            >
              <span style={itemTitleStyle}>{neighbor.title !== '' ? neighbor.title : neighbor.id}</span>
            </button>
          ))}
        </div>
      ) : null}

      {data.children.length > 0 ? (
        <div style={columnStyle}>
          <p style={sectionTitleStyle}>{t('detail.children')}</p>
          {data.children.map((neighbor) => (
            <button
              key={neighbor.id}
              type="button"
              style={neighborButtonStyle}
              onClick={() => actions.select(neighbor.id)}
            >
              <span style={itemTitleStyle}>{neighbor.title !== '' ? neighbor.title : neighbor.id}</span>
              {neighbor.summary !== '' ? <span style={itemSummaryStyle}>{neighbor.summary}</span> : null}
            </button>
          ))}
        </div>
      ) : null}

      {data.chain.ancestors.length > 0 || data.chain.descendants.length > 0 ? (
        <div style={columnStyle}>
          <p style={sectionTitleStyle}>{t('detail.chain')}</p>
          <div style={chainRowStyle}>
            {data.chain.ancestors.map((neighbor) => (
              <button
                key={`ancestor-${neighbor.id}`}
                type="button"
                style={chainLinkStyle}
                onClick={() => actions.select(neighbor.id)}
              >
                {neighbor.title !== '' ? neighbor.title : neighbor.id}
              </button>
            ))}
            {data.chain.entry.id !== '' ? (
              <span style={badgeStyle}>
                {data.chain.entry.title !== '' ? data.chain.entry.title : data.chain.entry.id}
              </span>
            ) : null}
            {data.chain.descendants.map((neighbor) => (
              <button
                key={`descendant-${neighbor.id}-${neighbor.depth}`}
                type="button"
                style={chainLinkStyle}
                onClick={() => actions.select(neighbor.id)}
              >
                {neighbor.title !== '' ? neighbor.title : neighbor.id} · {neighbor.depth}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
