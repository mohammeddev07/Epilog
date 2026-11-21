import type { Episode, Media } from '../domain/media'

function season(number: number, titles: string[]): Episode[] {
  return titles.map((title, index) => ({ season: number, number: index + 1, title }))
}

export const demoCatalog: readonly Media[] = [
  {
    id: 'the-last-signal', title: 'The Last Signal', format: 'MOVIE', anime: false, year: 2025, runtime: 118, countries: ['US'], language: 'en',
    genres: ['Science fiction', 'Adventure'], poster: '/posters/the-last-signal.webp',
    description: 'A radio operator follows a mysterious transmission across a desert where the sun never quite sets.',
  },
  {
    id: 'northbound', title: 'Northbound', format: 'SERIES', anime: false, year: 2024, runtime: 52, countries: ['CA'], language: 'en',
    genres: ['Mystery', 'Drama'], poster: '/posters/northbound.webp',
    description: 'A mountain guide returns to her hometown after a rescue beacon lights up deep in the winter woods.',
    episodes: [...season(1, ['Whiteout', 'The Beacon', 'Tree Line']), ...season(2, ['Tracks', 'After the Thaw'])],
    episodeTotal: 5,
  },
  {
    id: 'paper-moons', title: 'Paper Moons', format: 'MOVIE', anime: true, year: 2024, runtime: 96, countries: ['JP'], language: 'ja',
    aliases: ['Kami no Tsuki'], genres: ['Fantasy', 'Drama'], poster: '/posters/paper-moons.webp',
    description: 'A girl sends a paper boat out to sea and spends one summer finding out where the moon takes it.',
  },
  {
    id: 'starlight-courier', title: 'Starlight Courier', format: 'GAME', year: 2025,
    genres: ['Adventure', 'Simulation'], poster: '/posters/starlight-courier.webp',
    description: 'Carry letters, spare parts, and secrets between little outposts at the edge of a gas giant.',
  },
  {
    id: 'lantern-season', title: 'Lantern Season', format: 'SERIES', anime: true, year: 2026, runtime: 24, countries: ['JP'], language: 'ja',
    aliases: ['Chōchin no Kisetsu'], genres: ['Fantasy', 'Slice of life'], poster: '/posters/lantern-season.webp',
    description: 'Two siblings spend their last summer in a riverside village helping to prepare its annual lantern festival.',
    episodes: season(1, ['First Light', 'The Old Bridge', 'On the River', 'The Last Lantern']),
  },
  {
    id: 'glass-tide', title: 'Glass Tide', format: 'MOVIE', anime: false, year: 2023, runtime: 104, countries: ['GB', 'FR'], language: 'en',
    genres: ['Drama'], poster: '/posters/glass-tide.webp',
    description: 'A family comes home to a seaside town to decide what to do with their shuttered glassworks.',
  },
  {
    id: 'driftwood-archive', title: 'Driftwood Archive', format: 'GAME', year: 2026,
    genres: ['Exploration'], description: 'Restore an island archive one salvaged letter at a time.',
  },
]

export const demoById = new Map(demoCatalog.map((media) => [media.id, media]))
