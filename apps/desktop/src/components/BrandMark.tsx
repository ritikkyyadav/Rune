interface BrandMarkProps {
  size?: number;
  className?: string;
  title?: string;
}

export function BrandMark({ size = 28, className = "", title }: BrandMarkProps) {
  return (
    <span
      className={`brand-mark ${className}`.trim()}
      style={{ width: size, height: size }}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      <img src="/brand/gear-mark.svg" alt="" draggable={false} />
    </span>
  );
}
