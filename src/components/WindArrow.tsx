interface WindCompassProps {
  windEnabled: boolean;
  windDirection: number;
  windSpeed: number;
}

export function WindCompass({ windEnabled, windDirection, windSpeed }: WindCompassProps) {
  if (!windEnabled) return null;

  const arrowColor = getWindColor(windSpeed);
  const arrowSize = getArrowSize(windSpeed);

  return (
    <div className="wind-compass" key={`compass-${windSpeed}`}>
      <div className="wind-compass-inner">
        <div className="compass-rose">
          <div className="compass-north">N</div>
          <div className="compass-east">E</div>
          <div className="compass-south">S</div>
          <div className="compass-west">W</div>
          <div className="compass-circle" />
        </div>
        <div
          className="wind-arrow-wrapper"
          style={{
            transform: `translate(-50%, -50%) rotate(${windDirection}deg)`,
            width: `${arrowSize}px`,
            height: `${arrowSize}px`,
            boxSizing: 'border-box'
          }}
        >
          <svg
            width={arrowSize}
            height={arrowSize}
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            style={{ display: 'block' }}
            key={`arrow-${windSpeed}`}
          >
            <path
              d="M12 2L2 12H10V22L12 20L14 22V12H22L12 2Z"
              fill={arrowColor}
              stroke="white"
              strokeWidth="1.5"
            />
          </svg>
        </div>
        <div className="wind-speed-label">{Math.round(windSpeed)} m/s</div>
      </div>
    </div>
  );
}

function getWindColor(speed: number): string {
  if (speed === 0) return '#888888';
  if (speed < 5) return '#00aa00';
  if (speed < 10) return '#ffff00';
  if (speed < 15) return '#ffaa00';
  return '#ff0000';
}

function getArrowSize(speed: number): number {
  return 40 + Math.min(speed * 2, 40);
}

