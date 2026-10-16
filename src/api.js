const API = '/api'
export function getToken() { return localStorage.getItem('campusfix_token') }
export function setSession(token, user) { localStorage.setItem('campusfix_token', token); localStorage.setItem('campusfix_user', JSON.stringify(user)) }
export function clearSession() { localStorage.removeItem('campusfix_token'); localStorage.removeItem('campusfix_user') }
export async function request(path, options = {}) {
  const headers = new Headers(options.headers || {})
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (!(options.body instanceof FormData) && options.body !== undefined) headers.set('Content-Type', 'application/json')
  const response = await fetch(`${API}${path}`, { ...options, headers })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    if (response.status === 401) clearSession()
    throw new Error(payload.error || 'Request failed. Please try again.')
  }
  return payload
}
