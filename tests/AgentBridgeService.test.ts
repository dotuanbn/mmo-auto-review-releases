import { request as httpRequest } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentBridgeService, type AgentBridgeController } from '../src/main/services/AgentBridgeService'

function controller(): AgentBridgeController & { calls: string[] } {
    const calls: string[] = []
    return {
        calls,
        snapshot: () => ({ ok: true, password: 'secret-value', nested: { apiKey: 'k' } }),
        listAccounts: () => [],
        listCampaigns: () => [],
        listLocations: () => [],
        readLog: () => ({ text: '' }),
        startTraffic: () => { calls.push('startTraffic'); return { started: true } },
        pauseTraffic: () => { calls.push('pauseTraffic'); return { paused: true } },
        resumeTraffic: () => ({ resumed: true }),
        stopTraffic: () => { calls.push('stopTraffic'); return { stopped: true } },
        startAutomation: () => ({ success: true }),
        pauseAutomation: () => ({ paused: true }),
        resumeAutomation: () => ({ resumed: true }),
        stopAutomation: () => ({ stopped: true }),
        recycleBrowser: (force: boolean) => ({ recycled: force }),
    }
}

function call(
    port: number,
    path: string,
    token: string | null,
    method = 'GET',
    host = `127.0.0.1:${port}`,
): Promise<{ status: number; body: { ok?: boolean; error?: string; data?: { password?: string; nested?: { apiKey?: string } } } }> {
    return new Promise((resolve, reject) => {
        const req = httpRequest({
            host: '127.0.0.1',
            port,
            path,
            method,
            headers: {
                host,
                ...(token ? { 'x-agent-token': token } : {}),
            },
        }, (res) => {
            const chunks: Buffer[] = []
            res.on('data', (chunk) => chunks.push(chunk))
            res.on('end', () => {
                resolve({
                    status: res.statusCode || 0,
                    body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
                })
            })
        })
        req.on('error', reject)
        req.end()
    })
}

describe('AgentBridgeService', () => {
    const services: AgentBridgeService[] = []

    afterEach(async () => {
        await Promise.all(services.splice(0).map((service) => service.stop()))
    })

    async function start() {
        const service = new AgentBridgeService()
        services.push(service)
        const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-'))
        service.configure({
            statePath: join(dir, 'agent-bridge.json'),
            controller: controller(),
            preferredPort: 0,
        })
        await service.start()
        const state = service.getPublicState()
        if (!state.port || !state.token) throw new Error('bridge did not listen')
        return { service, port: state.port, token: state.token }
    }

    it('rejects missing token and non-loopback host', async () => {
        const { port, token } = await start()
        const missing = await call(port, '/v1/snapshot', null)
        expect(missing.status).toBe(401)
        const foreignHost = await call(port, '/v1/snapshot', token, 'GET', 'evil.example')
        expect(foreignHost.status).toBe(403)
    })

    it('redacts secrets and stops traffic only with the token', async () => {
        const { port, token } = await start()
        const snapshot = await call(port, '/v1/snapshot', token)
        expect(snapshot.status).toBe(200)
        expect(snapshot.body.data?.password).toBe('[redacted]')
        expect(snapshot.body.data?.nested?.apiKey).toBe('[redacted]')
        const stopped = await call(port, '/v1/traffic/stop', token, 'POST')
        expect(stopped.status).toBe(200)
        expect(stopped.body.ok).toBe(true)
    })

    it('closes the port when stopped', async () => {
        const { service, port, token } = await start()
        await service.stop()
        await expect(call(port, '/v1/help', token)).rejects.toThrow()
        expect(service.getPublicState().listening).toBe(false)
        expect(service.getPublicState().token).toBeNull()
    })
})
