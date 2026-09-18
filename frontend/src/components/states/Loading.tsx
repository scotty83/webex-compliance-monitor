/* Skeleton grid — shown during first load. Each card matches MeetingCard shape.
   Under prefers-reduced-motion the global CSS collapses animation-duration to
   0.001ms, making the pulse static (no class toggling needed). */

function SkeletonBlock({
  width = '100%',
  height,
  radius = '4px',
  style,
}: {
  width?: string | number
  height: string | number
  radius?: string
  style?: React.CSSProperties
}) {
  return (
    <div
      className="skeleton-block"
      style={{
        background: 'var(--s2)',
        borderRadius: radius,
        width,
        height,
        flexShrink: 0,
        ...style,
      }}
    />
  )
}

function SkeletonCard() {
  return (
    <div
      style={{
        background: 'var(--s1)',
        borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--line)',
        padding: '18px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}
    >
      {/* Title row */}
      <SkeletonBlock height={18} width="68%" />

      {/* Org + SIP */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <SkeletonBlock height={13} width="52%" />
        <SkeletonBlock height={12} width="80%" />
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: 'var(--line)' }} />

      {/* Status row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
        <SkeletonBlock height={14} width="40%" />
        <SkeletonBlock height={14} width="28%" />
      </div>

      {/* Avatar row */}
      <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="skeleton-block"
            style={{
              width: 30,
              height: 30,
              borderRadius: '50%',
              background: 'var(--s2)',
              flexShrink: 0,
            }}
          />
        ))}
        <SkeletonBlock height={13} width="60px" style={{ marginLeft: '8px' }} />
      </div>

      {/* Button skeleton */}
      <SkeletonBlock height={38} radius="10px" />
    </div>
  )
}

const SKELETON_COUNT = 6

export function Loading() {
  return (
    <div
      data-testid="loading-skeleton"
      aria-label="Loading meetings…"
      aria-busy="true"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
        gap: '16px',
      }}
    >
      {Array.from({ length: SKELETON_COUNT }, (_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  )
}
