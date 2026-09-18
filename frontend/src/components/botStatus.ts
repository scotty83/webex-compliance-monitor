import type { LucideIcon } from 'lucide-react'
import {
  AlertTriangle,
  CheckCircle,
  Circle,
  CircleSlash,
  Loader2,
  Unplug,
} from 'lucide-react'
import type { BotState } from '../types'

export interface BotStatusConfig {
  colorVar: string
  bgVar: string | null
  label: string
  Glyph: LucideIcon
}

export const BOT_STATUS_MAP: Record<BotState, BotStatusConfig> = {
  connected:    { colorVar: '--green', bgVar: '--green-bg', label: 'Connected',    Glyph: CheckCircle   },
  dialing:      { colorVar: '--amber', bgVar: '--amber-bg', label: 'Dialing',      Glyph: Loader2       },
  disconnected: { colorVar: '--red',   bgVar: '--red-bg',   label: 'Disconnected', Glyph: Unplug        },
  failed:       { colorVar: '--red',   bgVar: '--red-bg',   label: 'Failed',       Glyph: AlertTriangle },
  idle:         { colorVar: '--tx3',   bgVar: null,         label: 'Idle',         Glyph: Circle        },
  ended:        { colorVar: '--tx3',   bgVar: null,         label: 'Ended',        Glyph: CircleSlash   },
}
