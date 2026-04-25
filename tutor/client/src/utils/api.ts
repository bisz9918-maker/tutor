export function apiUrl(path: string): string {
  return new URL(path, window.location.href).href
}

export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem('session_token')
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> || {}),
  }
  if (token) headers['x-session-token'] = token
  if (init.body && !(init.body instanceof Blob) && !(init.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
  }
  return fetch(apiUrl(path), { ...init, headers })
}
