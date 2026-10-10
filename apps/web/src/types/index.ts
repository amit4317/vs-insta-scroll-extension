// Shared TypeScript interfaces for ERP System

export interface User {
  _id: string;
  companyId: string;
  name: string;
  email: string;
  phone?: string;
  role: 'admin' | 'manager' | 'staff' | 'viewer';
  permissions: ModulePermission[];
  avatar?: string;
  isActive: boolean;
  lastLogin?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ModulePermission {
  module: string;
  actions: string[];
}

export interface Company {
  _id: string;
  name: string;
  displayName?: string;
  gstin?: string;
  pan?: string;
  address: Address;
  contact: ContactInfo;
  logo?: string;
  signature?: string;
  bankAccounts: BankAccount[];
  financialYear: FinancialYear;
  sequences: DocumentSequences;
  defaultTaxRate: number;
  currency: string;
  dateFormat: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Address {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  stateCode?: number;
  pincode?: string;
  country?: string;
}

export interface ContactInfo {
  phone?: string;
  mobile?: string;
  email?: string;
  website?: string;
  contactPerson?: string;
}

export interface BankAccount {
  bankName?: string;
  accountNumber?: string;
  ifscCode?: string;
  branchName?: string;
  accountType?: 'current' | 'savings';
  isDefault?: boolean;
}

export interface FinancialYear {
  startMonth: number;
  current: string;
}

export interface DocumentSequences {
  invoice: SequenceConfig;
  purchase: SequenceConfig;
  quotation: SequenceConfig;
  saleOrder: SequenceConfig;
  purchaseOrder: SequenceConfig;
  deliveryChallan: SequenceConfig;
  creditNote: SequenceConfig;
  debitNote: SequenceConfig;
  proformaInvoice: SequenceConfig;
  receipt: SequenceConfig;
  jobWork: SequenceConfig;
}

export interface SequenceConfig {
  prefix: string;
  next: number;
}

export interface Customer {
  _id: string;
  companyId: string;
  type: 'customer' | 'vendor' | 'both';
  name: string;
  displayName?: string;
  gstin?: string;
  pan?: string;
  billingAddress?: Address;
  shippingAddresses: Address[];
  contact: ContactInfo;
  financials: CustomerFinancials;
  gstInfo?: GSTInfo;
  bankDetails?: BankDetails;
  customFields?: Record<string, any>;
  tags?: string[];
  notes?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CustomerFinancials {
  openingBalance: number;
  openingBalanceType: 'debit' | 'credit';
  creditLimit: number;
  creditDays: number;
  currentBalance: number;
}

export interface GSTInfo {
  isGSTRegistered?: boolean;
  placeOfSupply?: string;
  stateCode?: number;
}

export interface BankDetails {
  bankName?: string;
  accountNumber?: string;
  ifscCode?: string;
}

export interface Product {
  _id: string;
  companyId: string;
  name: string;
  sku?: string;
  barcode?: string;
  hsnCode?: string;
  category?: string;
  unit: string;
  type: 'product' | 'service' | 'raw_material' | 'finished_good';
  description?: string;
  images?: string[];
  pricing: ProductPricing;
  stock: ProductStock;
  isInventoryTracked: boolean;
  customFields?: Record<string, any>;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProductPricing {
  purchaseRate?: number;
  sellingRate?: number;
  mrp?: number;
  taxType: 'inclusive' | 'exclusive';
  taxRate: number;
}

export interface ProductStock {
  openingStock: number;
  currentStock: number;
  minStockLevel?: number;
  maxStockLevel?: number;
  reorderPoint?: number;
}

export interface LineItem {
  _id?: string;
  productId?: string;
  productName: string;
  description?: string;
  hsnCode?: string;
  unit?: string;
  quantity: number;
  rate: number;
  discount?: number;
  discountType?: 'percent' | 'amount';
  taxRate?: number;
  taxBreakup: TaxBreakup;
  amount: number;
  taxAmount: number;
  totalAmount: number;
  customFields?: Record<string, any>;
}

export interface TaxBreakup {
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
}

export interface DocumentTotals {
  subtotal: number;
  totalDiscount: number;
  totalTaxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  totalTax: number;
  roundOff: number;
  grandTotal: number;
}

export interface Invoice {
  _id: string;
  companyId: string;
  invoiceNumber: string;
  invoiceType: 'tax' | 'proforma' | 'export' | 'sez' | 'bill_of_supply';
  date: Date;
  dueDate?: Date;
  customerId: string;
  customerSnapshot: CustomerSnapshot;
  billingAddress?: Address;
  shippingAddress?: Address;
  placeOfSupply: string;
  supplyType: 'intraState' | 'interState' | 'export' | 'sez';
  items: LineItem[];
  totals: DocumentTotals;
  amountInWords: string;
  paymentStatus: 'unpaid' | 'partial' | 'paid';
  paidAmount: number;
  balanceDue: number;
  sourceQuotationId?: string;
  sourceSaleOrderId?: string;
  templateId: string;
  notes?: string;
  termsConditions?: string;
  shippingDetails?: ShippingDetails;
  eInvoice?: EInvoiceDetails;
  eWayBillNumber?: string;
  customFields?: Record<string, any>;
  status: 'draft' | 'confirmed' | 'cancelled';
  createdAt: Date;
  updatedAt: Date;
}

export interface CustomerSnapshot {
  name: string;
  gstin?: string;
  address?: Address;
}

export interface ShippingDetails {
  transporterName?: string;
  vehicleNumber?: string;
  lrNumber?: string;
  dispatchDate?: Date;
}

export interface EInvoiceDetails {
  irn?: string;
  ackNumber?: string;
  ackDate?: Date;
  qrCode?: string;
  status: 'pending' | 'generated' | 'cancelled';
  cancelReason?: string;
  cancelDate?: Date;
}

export interface APIResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
  pagination?: PaginationInfo;
  error?: APIError;
}

export interface PaginationInfo {
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export interface APIError {
  code: string;
  message: string;
  details?: Record<string, any>;
}

export interface DashboardData {
  kpis: {
    todaySales: number;
    todayCollections: number;
    monthSales: number;
    monthPurchases: number;
    totalReceivable: number;
    totalPayable: number;
    lowStockCount: number;
  };
  charts: {
    monthlySales: { month: string; sales: number; purchases: number }[];
    topCustomers: { name: string; total: number }[];
    topProducts: { name: string; qty: number; revenue: number }[];
    paymentModeBreak: { mode: string; amount: number }[];
  };
  alerts: {
    overdueInvoices: Invoice[];
    lowStockItems: Product[];
    upcomingDueDate: Invoice[];
  };
}
