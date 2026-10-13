/**
 * Dashboard overview IPC.
 * Channel: dashboard:getOverview() → DashboardOverview
 */
import { ipcMain } from 'electron'
import { dashboardService } from '../services/DashboardService'

ipcMain.handle('dashboard:getOverview', () => dashboardService.getOverview())
