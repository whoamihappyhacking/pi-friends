export const liveNoticeBatch = (team: any, events: any[]) =>
  events.filter(event => team?.agents.some((agent: any) => agent.id === event.agent.id && agent.status !== 'departed'));

export const noticeTriggersTurn = (reason: string) =>
  ['done', 'failed', 'blocked', 'stopped'].includes(reason);
