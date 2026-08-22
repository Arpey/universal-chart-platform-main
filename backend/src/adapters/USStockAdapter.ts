import { BaseAdapter } from './BaseAdapter'
export class USStockAdapter extends BaseAdapter { getKlines(): Promise<any[]> { return Promise.reject(new Error('US stock adapter is not implemented')) } getTicker(): Promise<any> { return Promise.reject(new Error('US stock adapter is not implemented')) } subscribe(): () => void { return () => {} } }
