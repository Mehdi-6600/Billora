export function BrandMark({ size = 36 }: { size?: number }) {
  return (
    <span className="brand-mark" style={{ width: size, height: size }} aria-hidden="true">
      <img src={`${import.meta.env.BASE_URL}billora-icon.svg`} alt="" width={size} height={size} />
    </span>
  )
}
