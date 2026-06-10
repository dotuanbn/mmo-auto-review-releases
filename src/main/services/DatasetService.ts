/**
 * DatasetService.ts — HuggingFace Dataset Viewer API Wrapper
 *
 * Read-only REST client for browsing, searching, and importing
 * datasets from the HF Hub. No npm dependencies — uses Electron net.fetch.
 *
 * Based on: https://datasets-server.huggingface.co
 */

import { net } from 'electron'

// ============================================================
// Types
// ============================================================

export interface DatasetSplit {
  dataset: string
  config: string
  split: string
}

export interface DataRow {
  row_idx: number
  row: Record<string, unknown>
}

export interface DatasetSize {
  dataset: string
  configs: {
    config: string
    num_rows: number
    num_bytes: number
    splits: { split: string; num_rows: number; num_bytes: number }[]
  }[]
}

export interface DatasetValidation {
  valid: boolean
  viewer: boolean
  search: boolean
  filter: boolean
}

// ============================================================
// Constants
// ============================================================

const BASE_URL = 'https://datasets-server.huggingface.co'
const DEFAULT_PAGE_SIZE = 20

// ============================================================
// DatasetService
// ============================================================

class DatasetService {
  /**
   * Check if a dataset is available on the HF Dataset Viewer.
   */
  async isValid(datasetId: string): Promise<DatasetValidation> {
    const data = await this.fetchJson(`/is-valid?dataset=${encodeURIComponent(datasetId)}`)
    return data as unknown as DatasetValidation
  }

  /**
   * List all configs and splits for a dataset.
   */
  async listSplits(datasetId: string): Promise<DatasetSplit[]> {
    const data = await this.fetchJson(`/splits?dataset=${encodeURIComponent(datasetId)}`)
    return (data as any).splits ?? []
  }

  /**
   * Preview first rows of a dataset split.
   */
  async previewRows(
    datasetId: string,
    config: string,
    split: string,
    limit: number = DEFAULT_PAGE_SIZE
  ): Promise<{ rows: DataRow[]; features: Record<string, unknown>[] }> {
    const url = `/first-rows?dataset=${encodeURIComponent(datasetId)}&config=${encodeURIComponent(config)}&split=${encodeURIComponent(split)}`
    const data = await this.fetchJson(url)
    const rawRows = (data as any).rows ?? []
    return {
      rows: rawRows.slice(0, limit).map((r: any) => ({
        row_idx: r.row_idx,
        row: r.row,
      })),
      features: (data as any).features ?? [],
    }
  }

  /**
   * Paginate through dataset rows.
   */
  async getRows(
    datasetId: string,
    config: string,
    split: string,
    offset: number = 0,
    length: number = DEFAULT_PAGE_SIZE
  ): Promise<{ rows: DataRow[]; numRowsTotal: number }> {
    const clamped = Math.min(length, 100) // HF API max is 100
    const url = `/rows?dataset=${encodeURIComponent(datasetId)}&config=${encodeURIComponent(config)}&split=${encodeURIComponent(split)}&offset=${offset}&length=${clamped}`
    const data = await this.fetchJson(url)
    return {
      rows: ((data as any).rows ?? []).map((r: any) => ({
        row_idx: r.row_idx,
        row: r.row,
      })),
      numRowsTotal: (data as any).num_rows_total ?? 0,
    }
  }

  /**
   * Full-text search within a dataset split.
   */
  async search(
    datasetId: string,
    config: string,
    split: string,
    query: string,
    offset: number = 0,
    length: number = DEFAULT_PAGE_SIZE
  ): Promise<{ rows: DataRow[]; numRowsTotal: number }> {
    const clamped = Math.min(length, 100)
    const url = `/search?dataset=${encodeURIComponent(datasetId)}&config=${encodeURIComponent(config)}&split=${encodeURIComponent(split)}&query=${encodeURIComponent(query)}&offset=${offset}&length=${clamped}`
    const data = await this.fetchJson(url)
    return {
      rows: ((data as any).rows ?? []).map((r: any) => ({
        row_idx: r.row_idx,
        row: r.row,
      })),
      numRowsTotal: (data as any).num_rows_total ?? 0,
    }
  }

  /**
   * Get total size information for a dataset.
   */
  async getSize(datasetId: string): Promise<DatasetSize> {
    const data = await this.fetchJson(`/size?dataset=${encodeURIComponent(datasetId)}`)
    return {
      dataset: datasetId,
      configs: ((data as any).size?.configs ?? []).map((c: any) => ({
        config: c.config,
        num_rows: c.num_rows,
        num_bytes: c.num_bytes,
        splits: c.splits ?? [],
      })),
    }
  }

  /**
   * Get column statistics for a specific split.
   */
  async getStatistics(
    datasetId: string,
    config: string,
    split: string
  ): Promise<Record<string, unknown>> {
    const url = `/statistics?dataset=${encodeURIComponent(datasetId)}&config=${encodeURIComponent(config)}&split=${encodeURIComponent(split)}`
    return await this.fetchJson(url)
  }

  // ============================================================
  // Internal — HTTP Client
  // ============================================================

  private async fetchJson(path: string): Promise<Record<string, unknown>> {
    const url = `${BASE_URL}${path}`

    try {
      const response = await net.fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      })

      if (!response.ok) {
        const errorBody = await response.text()
        throw new Error(
          `HF Dataset API error (${response.status}): ${errorBody.slice(0, 200)}`
        )
      }

      return await response.json() as Record<string, unknown>
    } catch (err: any) {
      if (err.message?.includes('HF Dataset API error')) {
        throw err
      }
      throw new Error(`Failed to reach HF Dataset API: ${err.message}`)
    }
  }
}

// ============================================================
// Singleton Export
// ============================================================

export const datasetService = new DatasetService()
