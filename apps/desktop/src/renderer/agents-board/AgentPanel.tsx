import { UnstyledButton } from '@mantine/core'
import {
  IconExternalLink,
  IconFileText,
  IconFolder,
  IconGitPullRequest,
  IconMessageCircle,
  IconTicket,
  type Icon,
} from '@tabler/icons-react'
import type { AgentCard, AgentLink, AgentOpen } from '@evaos/contract'
import { openActivity } from '../activity/open-activity'
import { openContext } from '../context/open-context'
import { openTargetOf, type OpenTarget } from '../navigation/open-target'
import { EvaDrawer } from '../overlay'
import { ListPill } from '../ui/list'
import { COLUMN_ICON, PILL_TONE, prWords } from './AgentCard'
import { clockLabel } from '../context/format'
import { COLUMN_TITLE } from './board-view'

const LINK_ICON: Record<AgentLink['kind'], Icon> = {
  linear: IconTicket,
  pr: IconGitPullRequest,
  session: IconMessageCircle,
  ledger: IconFileText,
  worktree: IconFolder,
}

/** Opens a board link: a live run through the activity opener, everything else as a context row does. */
export function openAgentLink(open: AgentOpen, target: OpenTarget): void {
  if (open.kind === 'activity') void openActivity(open.item, target)
  else openContext(open, target)
}

function Fact({ label, children }: { label: string; children: string | null }) {
  if (!children) return null
  return (
    <>
      <dt className="eva-ab-factlabel">{label}</dt>
      <dd className="eva-ab-factvalue">{children}</dd>
    </>
  )
}

/** The side panel: where the card sits and why, its links (Linear, PR, session, ledger), its facts. */
export function AgentPanel({
  card,
  now,
  onClose,
}: {
  card: AgentCard | null
  now: number
  onClose: () => void
}) {
  const Column = card ? COLUMN_ICON[card.column] : null
  return (
    <EvaDrawer
      opened={card !== null}
      onClose={onClose}
      size={440}
      testid="agents-panel"
      title={
        card ? (
          <span className="eva-ab-ptitle">
            {card.key ? <span className="eva-ab-key">{card.key}</span> : null}
            <span>{card.title}</span>
          </span>
        ) : null
      }
    >
      {card && Column ? (
        <div className="eva-ab-panel">
          <section className="eva-ab-pstatus">
            <div className="eva-ab-pcolumn" data-column={card.column}>
              <Column size={16} stroke={1.75} className="eva-ab-colicon" aria-hidden />
              <span>{COLUMN_TITLE[card.column]}</span>
              <ListPill tone={PILL_TONE[card.pill.tone]}>{card.pill.label}</ListPill>
            </div>
            <p className="eva-ab-reason" data-testid="agents-panel-reason">
              {card.reason}
            </p>
          </section>

          {card.links.length > 0 ? (
            <section className="eva-ab-psection">
              <h2 className="eva-ab-phead">Links</h2>
              <div className="eva-ab-links">
                {card.links.map((l, i) => {
                  const Glyph = LINK_ICON[l.kind]
                  return (
                    <UnstyledButton
                      key={`${l.kind}:${l.label}:${i}`}
                      className="eva-ab-link"
                      data-testid={`agents-link-${l.kind}`}
                      onClick={(e) => openAgentLink(l.open, openTargetOf(e))}
                    >
                      <Glyph size={16} stroke={1.5} className="eva-ab-linkicon" aria-hidden />
                      <span className="eva-ab-linktext">
                        <span className="eva-ab-linklabel">{l.label}</span>
                        {l.sub ? <span className="eva-ab-linksub">{l.sub}</span> : null}
                      </span>
                      {l.open.kind === 'url' ? (
                        <IconExternalLink
                          size={14}
                          stroke={1.5}
                          className="eva-ab-linkicon"
                          aria-hidden
                        />
                      ) : null}
                    </UnstyledButton>
                  )
                })}
              </div>
            </section>
          ) : null}

          <section className="eva-ab-psection">
            <h2 className="eva-ab-phead">Details</h2>
            <dl className="eva-ab-facts">
              <Fact label="Agent">{card.agent}</Fact>
              <Fact label="Session">{card.session}</Fact>
              <Fact label="Latest">{card.intent}</Fact>
              <Fact label="Auto-work">{card.phase}</Fact>
              <Fact label="Stage">{card.stage}</Fact>
              <Fact label="Whose move">{card.move}</Fact>
              <Fact label="Next">{card.next}</Fact>
              <Fact label="Linear">{card.linear?.state ?? null}</Fact>
              <Fact label="Pull request">{card.pr ? prWords(card.pr) : null}</Fact>
              <Fact label="Workspace">{card.workspace}</Fact>
              <Fact label="Last activity">
                {card.activityAt === null ? null : clockLabel(card.activityAt, now)}
              </Fact>
            </dl>
          </section>
        </div>
      ) : null}
    </EvaDrawer>
  )
}
