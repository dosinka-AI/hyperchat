/** games shown on /games. only add titles you own or have permission to embed. */

export type HyperGame = {
  id: string
  title: string
  blurb: string
  /** official embed url (iframe). leave empty for a coming-soon tile. */
  embedUrl?: string
  /** optional link-out if the game cannot be iframed. */
  externalUrl?: string
}

export const HYPER_GAMES: HyperGame[] = [
  {
    id: 'slot-1',
    title: 'coming soon',
    blurb: 'drop in an embed url when you have a game you can host.',
  },
  {
    id: 'slot-2',
    title: 'coming soon',
    blurb: 'same Hyperion shell, your game in the frame.',
  },
  {
    id: 'slot-3',
    title: 'coming soon',
    blurb: 'open-source and self-hosted html5 games work best.',
  },
  {
    id: 'slot-4',
    title: 'coming soon',
    blurb: 'external portals can be linked out if they block iframes.',
  },
  {
    id: 'slot-5',
    title: 'coming soon',
    blurb: 'placeholder tile.',
  },
  {
    id: 'slot-6',
    title: 'coming soon',
    blurb: 'placeholder tile.',
  },
  {
    id: 'slot-7',
    title: 'coming soon',
    blurb: 'placeholder tile.',
  },
  {
    id: 'slot-8',
    title: 'coming soon',
    blurb: 'placeholder tile.',
  },
]
