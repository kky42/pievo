export function OpenModeWarning({ className = '' }: { className?: string }) {
  return (
    <div role="alert" className={`${className} rounded-control border border-warn/40 bg-warn/10 px-4 py-3 text-meta text-primary`}>
      <strong>Open mode:</strong> anyone who can reach this server can view and manage every loop, machine, run, and artifact. Restrict access to localhost, a trusted private network, or an authenticated reverse proxy.
    </div>
  )
}
