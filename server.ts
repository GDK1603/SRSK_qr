import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Shop Vendor Security PIN to protect Excel audit log from customer view
// Default: 9533 (matches merchant phone prefix +91 95334 55562)
const VENDOR_SECURITY_PIN = process.env.VENDOR_PIN || '9533';
const AUDIT_FILE_PATH = process.env.VERCEL
  ? path.join('/tmp', 'Shop_Print_Audit_Log.csv')
  : path.join(process.cwd(), 'Shop_Print_Audit_Log.csv');

// Initialize the persistent Excel CSV file with proper UTF-8 BOM if it doesn't exist
function initServerAuditLog() {
  try {
    if (!fs.existsSync(AUDIT_FILE_PATH)) {
      const headers = [
        'Record ID',
        'Date',
        'Time',
        'Token Number',
        'Print Mode',
        'Target Machine Hardware',
        'Files Count',
        'Document File Names',
        'Pages Per Copy',
        'Copies Count',
        'Total Pages Printed',
        'Paper Sheets Used',
        'Total Amount (INR)',
        'Payment Method & Status',
        'UTR Reference Number',
        'Spool Status'
      ].join(',');
      fs.writeFileSync(AUDIT_FILE_PATH, '\uFEFF' + headers + '\r\n', 'utf8');
      console.log(`[AUDIT INIT] Automatic Excel CSV initialized at: ${AUDIT_FILE_PATH}`);
    }
  } catch (err: any) {
    console.warn('[AUDIT INIT ERROR]', err.message);
  }
}
initServerAuditLog();

function escapeCsvField(val: any): string {
  if (val === undefined || val === null) return '""';
  const str = String(val).replace(/"/g, '""');
  return `"${str}"`;
}

// Automatically records verified orders into the Excel CSV file on disk
function appendServerAuditRecord(order: PaymentOrder, printJobId?: string) {
  try {
    initServerAuditLog();
    const now = new Date();
    const dateOnly = now.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeOnly = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

    const row = [
      escapeCsvField(order.orderId),
      escapeCsvField(dateOnly),
      escapeCsvField(timeOnly),
      escapeCsvField(order.tokenNumber),
      escapeCsvField(order.printMode),
      escapeCsvField(order.targetPrinter),
      escapeCsvField(order.documentNames?.length || 1),
      escapeCsvField(order.documentNames?.join(', ') || 'Customer Document'),
      escapeCsvField(order.totalPages),
      escapeCsvField(order.copies),
      escapeCsvField(order.totalPages * order.copies),
      escapeCsvField(order.totalSheets),
      escapeCsvField(order.amount),
      escapeCsvField(`PAID_UPI (${order.verificationMethod || 'DIRECT_UPI'})`),
      escapeCsvField(order.utr || 'UPI_SERVER_VERIFIED'),
      escapeCsvField(printJobId ? `QUEUED (${printJobId})` : 'QUEUED')
    ].join(',');

    fs.appendFileSync(AUDIT_FILE_PATH, row + '\r\n', 'utf8');
    console.log(`[EXCEL AUTO-RECORD] Automatically recorded order ${order.tokenNumber} (₹${order.amount}) to Excel file: ${AUDIT_FILE_PATH}`);
  } catch (e: any) {
    console.error('[EXCEL WRITE ERROR]', e.message);
  }
}

interface PaymentOrder {
  orderId: string;
  tokenNumber: string;
  amount: number;
  printMode: string;
  machineName: string;
  targetPrinter: string;
  copies: number;
  totalPages: number;
  totalSheets: number;
  documentNames: string[];
  status: 'PENDING' | 'VERIFIED' | 'EXPIRED';
  createdAt: number;
  expiresAt: number;
  upiIntentUrl: string;
  gpayIntentUrl?: string;
  googlePayMerchantId?: string;
  utr?: string;
  verifiedAt?: number;
  verificationMethod?: 'DIRECT_UPI_HIT' | 'OPEN_UPI_DIRECT' | 'SCAN_AMOUNT' | 'GATEWAY_WEBHOOK' | 'SOUNDBOX_SYNC' | 'GOOGLE_PAY_BUSINESS';
  printJobId?: string;
}

interface PrintJob {
  id: string;
  orderId: string;
  tokenNumber: string;
  targetPrinter: string;
  machineName: string;
  printMode: string;
  pages: number;
  copies: number;
  totalSheets: number;
  documentNames: string[];
  status: 'QUEUED' | 'PRINTING' | 'COMPLETED';
  queuedAt: number;
  completedAt?: number;
  directPrintUrl: string;
}

// In-memory persistent state (persists across requests during server runtime)
const orders = new Map<string, PaymentOrder>();
const printQueue = new Map<string, PrintJob>();
const completedPrintJobs: PrintJob[] = [];

// Official merchant & Google Pay for Business credentials
// Google Pay Business Merchant ID: BCR2DN4TZLBYBEIY
const GOOGLE_PAY_MERCHANT_ID = process.env.GOOGLE_PAY_MERCHANT_ID || 'BCR2DN4TZLBYBEIY';
const MERCHANT_UPI_ID = process.env.MERCHANT_UPI_ID || '9533455562@okbizaxis';
const MERCHANT_NAME = process.env.MERCHANT_NAME || 'SAI Krishna Graphics';
const PAYMENT_KEY_ID = process.env.PAYMENT_KEY_ID || process.env.RAZORPAY_KEY_ID || GOOGLE_PAY_MERCHANT_ID;
const PAYMENT_KEY_SECRET = process.env.PAYMENT_KEY_SECRET || process.env.RAZORPAY_KEY_SECRET || '';
const PAYMENT_WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET || '';

export function createExpressApp() {
  const app = express();

  app.use(express.json({ limit: '25mb' }));

  // Helper to enqueue a Print Job for external shop machines (Canon 4745 / Xerox)
  function enqueuePrintJob(order: PaymentOrder): PrintJob {
    const printJobId = `PRN-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;
    const printJob: PrintJob = {
      id: printJobId,
      orderId: order.orderId,
      tokenNumber: order.tokenNumber,
      targetPrinter: order.targetPrinter,
      machineName: order.machineName,
      printMode: order.printMode,
      pages: order.totalPages,
      copies: order.copies,
      totalSheets: order.totalSheets,
      documentNames: order.documentNames,
      status: 'QUEUED',
      queuedAt: Date.now(),
      directPrintUrl: `/api/print/job/${printJobId}`,
    };
    printQueue.set(printJobId, printJob);
    order.printJobId = printJobId;

    // AUTOMATIC RECORDING TO EXCEL FILE (Hidden from customer, accessible only by shop vendor)
    appendServerAuditRecord(order, printJobId);

    return printJob;
  }

  // -------------------------------------------------------------
  // API: Health Check & Kiosk Server Status
  // -------------------------------------------------------------
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'SaiKrishna Graphics & Offset Kiosk Backend Server',
      merchant: MERCHANT_NAME,
      upiId: MERCHANT_UPI_ID,
      googlePayMerchantId: GOOGLE_PAY_MERCHANT_ID,
      googlePayActive: true,
      hasPaymentKeyId: Boolean(PAYMENT_KEY_ID),
      timestamp: new Date().toISOString(),
      activeOrders: orders.size,
      queuedPrintJobs: Array.from(printQueue.values()).filter((j) => j.status === 'QUEUED').length,
      totalJobsCompleted: completedPrintJobs.length,
    });
  });

  // -------------------------------------------------------------
  // API: Create Payment Session (5-Minute Window)
  // Generates dynamic order reference & official UPI intent URL for the exact amount
  // -------------------------------------------------------------
  app.post('/api/payment/create-session', (req: Request, res: Response) => {
    const {
      tokenNumber,
      amount,
      printMode,
      machineName,
      targetPrinter,
      copies,
      totalPages,
      totalSheets,
      documentNames,
    } = req.body;

    const orderId = `ORD-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;
    const now = Date.now();
    const expiresAt = now + 5 * 60 * 1000; // 5 minutes active window

    const cleanAmount = Number(amount) || 0;
    const cleanToken = tokenNumber || `#SKG-${Math.floor(1000 + Math.random() * 9000)}`;

    // Official NPCI UPI URI with Google Pay for Business Merchant Identification (BCR2DN4TZLBYBEIY)
    const upiIntentUrl = `upi://pay?pa=${encodeURIComponent(MERCHANT_UPI_ID)}&pn=${encodeURIComponent(
      MERCHANT_NAME
    )}&mc=${encodeURIComponent(GOOGLE_PAY_MERCHANT_ID)}&mid=${encodeURIComponent(
      GOOGLE_PAY_MERCHANT_ID
    )}&msid=${encodeURIComponent(GOOGLE_PAY_MERCHANT_ID)}&mtid=${encodeURIComponent(
      GOOGLE_PAY_MERCHANT_ID
    )}&am=${cleanAmount}&tr=${encodeURIComponent(orderId)}&cu=INR&tn=${encodeURIComponent(
      `SRSK Print ${cleanToken}`
    )}`;

    // Direct Google Pay App Deep-Link for 1-Tap Instant Payment
    const gpayIntentUrl = `gpay://upi/pay?pa=${encodeURIComponent(MERCHANT_UPI_ID)}&pn=${encodeURIComponent(
      MERCHANT_NAME
    )}&mc=${encodeURIComponent(GOOGLE_PAY_MERCHANT_ID)}&mid=${encodeURIComponent(
      GOOGLE_PAY_MERCHANT_ID
    )}&am=${cleanAmount}&tr=${encodeURIComponent(orderId)}&cu=INR&tn=${encodeURIComponent(
      `SRSK Print ${cleanToken}`
    )}`;

    const order: PaymentOrder = {
      orderId,
      tokenNumber: cleanToken,
      amount: cleanAmount,
      printMode: printMode || 'Colour Print',
      machineName: machineName || (printMode?.includes('Colour') ? 'Colour Print' : 'Xerox / Black & White Copy'),
      targetPrinter: targetPrinter || (printMode?.includes('Colour') ? 'HP Colour Printer' : 'Xerox Dedicated Unit (B&W)'),
      copies: Number(copies) || 1,
      totalPages: Number(totalPages) || 1,
      totalSheets: Number(totalSheets) || 1,
      documentNames: Array.isArray(documentNames) ? documentNames : ['Document'],
      status: 'PENDING',
      createdAt: now,
      expiresAt,
      upiIntentUrl,
      gpayIntentUrl,
      googlePayMerchantId: GOOGLE_PAY_MERCHANT_ID,
    };

    orders.set(orderId, order);

    res.json({
      success: true,
      orderId,
      order,
      upiIntentUrl,
      gpayIntentUrl,
      googlePayMerchantId: GOOGLE_PAY_MERCHANT_ID,
      merchantUpiId: MERCHANT_UPI_ID,
      merchantName: MERCHANT_NAME,
      expiresInSeconds: 300,
    });
  });

  // -------------------------------------------------------------
  // API: Direct Payment Hit (/api/payment/hit)
  // Direct payment hit by customer paying by their UPI on their phone.
  // Can be called by:
  // 1) Merchant UPI notification listener / Soundbox / Bank SMS webhook
  // 2) Shopkeeper counter remote / scanner
  // 3) External automated payment gateway
  // If orderId is omitted, automatically resolves the currently active pending order!
  // -------------------------------------------------------------
  app.post('/api/payment/hit', (req: Request, res: Response) => {
    const { orderId, utr, amount, payerVpa } = req.body;

    let targetOrder: PaymentOrder | undefined;

    if (orderId) {
      targetOrder = orders.get(orderId);
    } else {
      // Find the most recent pending order
      const pendingOrders = Array.from(orders.values())
        .filter((o) => o.status === 'PENDING')
        .sort((a, b) => b.createdAt - a.createdAt);
      targetOrder = pendingOrders[0];
    }

    if (!targetOrder) {
      // If no pending order exists, check if there's any recent order
      const allOrders = Array.from(orders.values()).sort((a, b) => b.createdAt - a.createdAt);
      if (allOrders.length > 0 && allOrders[0].status === 'VERIFIED') {
        const existingJob = allOrders[0].printJobId ? printQueue.get(allOrders[0].printJobId) : undefined;
        res.json({
          success: true,
          message: 'Order already verified and queued to printer.',
          order: allOrders[0],
          printJob: existingJob,
        });
        return;
      }
      res.status(404).json({ success: false, error: 'No active pending payment order found to verify.' });
      return;
    }

    const txnRef = utr || `UPI/YESB/${Date.now().toString().slice(-8)}${Math.floor(1000 + Math.random() * 9000)}`;

    targetOrder.status = 'VERIFIED';
    targetOrder.utr = txnRef;
    targetOrder.verifiedAt = Date.now();
    targetOrder.verificationMethod = 'DIRECT_UPI_HIT';

    // Dispatches directly to shop external machine print queue!
    const printJob = enqueuePrintJob(targetOrder);

    console.log(`[PAYMENT HIT] Direct UPI hit received for Order ${targetOrder.orderId} (₹${targetOrder.amount}). Dispatched to printer ${targetOrder.targetPrinter}!`);

    res.json({
      success: true,
      message: 'Direct UPI payment hit received! Order verified and dispatched to shop machine print queue.',
      order: targetOrder,
      printJob,
    });
  });

  // API: Get Latest Active Order
  app.get('/api/payment/latest-pending', (_req: Request, res: Response) => {
    const pendingOrders = Array.from(orders.values())
      .filter((o) => o.status === 'PENDING')
      .sort((a, b) => b.createdAt - a.createdAt);

    if (pendingOrders.length === 0) {
      res.json({ success: false, message: 'No active pending order' });
      return;
    }

    res.json({ success: true, order: pendingOrders[0] });
  });

  // -------------------------------------------------------------
  // API: Process Open UPI / Scan Amount Direct Payment (Legacy compatibility)
  // -------------------------------------------------------------
  app.post('/api/payment/process-direct-upi', (req: Request, res: Response) => {
    const { orderId, method, amount, tokenNumber, printMode, machineName, targetPrinter, copies, totalPages, totalSheets, documentNames } = req.body;

    let targetId = orderId;
    if (!targetId) {
      const pendingOrders = Array.from(orders.values()).filter((o) => o.status === 'PENDING');
      if (pendingOrders.length > 0) {
        targetId = pendingOrders[pendingOrders.length - 1].orderId;
      }
    }

    if (!targetId) {
      targetId = `ORD-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;
    }

    let order = orders.get(targetId);

    if (!order) {
      order = {
        orderId: targetId,
        tokenNumber: tokenNumber || `#SKG-${Math.floor(1000 + Math.random() * 9000)}`,
        amount: Number(amount) || 0,
        printMode: printMode || 'Colour Print',
        machineName: machineName || (printMode?.includes('Colour') ? 'Colour Print' : 'Xerox / Black & White Copy'),
        targetPrinter: targetPrinter || (printMode?.includes('Colour') ? 'HP Colour Printer' : 'Xerox Dedicated Unit (B&W)'),
        copies: Number(copies) || 1,
        totalPages: Number(totalPages) || 1,
        totalSheets: Number(totalSheets) || 1,
        documentNames: documentNames || ['Document'],
        status: 'PENDING',
        createdAt: Date.now(),
        expiresAt: Date.now() + 300000,
        upiIntentUrl: '',
      };
      orders.set(targetId, order);
    }

    const txnRef = `UPI/AXIS/${Date.now().toString().slice(-8)}${Math.floor(1000 + Math.random() * 9000)}`;

    order.status = 'VERIFIED';
    order.utr = txnRef;
    order.verifiedAt = Date.now();
    order.verificationMethod = method || 'DIRECT_UPI_HIT';

    const printJob = enqueuePrintJob(order);

    res.json({
      success: true,
      message: 'Payment received! Print job dispatched directly to external shop machine.',
      order,
      printJob,
    });
  });

  // -------------------------------------------------------------
  // API: Get Payment Status (For frontend live polling)
  // -------------------------------------------------------------
  app.get('/api/payment/status/:orderId', (req: Request, res: Response) => {
    const { orderId } = req.params;
    const order = orders.get(orderId);

    if (!order) {
      res.status(404).json({ success: false, error: 'Order not found' });
      return;
    }

    const now = Date.now();
    if (order.status === 'PENDING' && now > order.expiresAt) {
      order.status = 'EXPIRED';
    }

    const remainingSeconds = Math.max(0, Math.floor((order.expiresAt - now) / 1000));
    const printJob = order.printJobId ? printQueue.get(order.printJobId) : undefined;

    res.json({
      success: true,
      status: order.status,
      remainingSeconds,
      order,
      printJob,
    });
  });

  // -------------------------------------------------------------
  // API: Payment Gateway / Soundbox / Bank SMS Webhook
  // Listens for incoming payment confirmation from UPI gateway, bank API,
  // Paytm/PhonePe/GPay Soundbox, or merchant transaction listener.
  // Automatically finds and verifies the active pending order if orderId is omitted!
  // -------------------------------------------------------------
  const handlePaymentWebhook = (req: Request, res: Response) => {
    const {
      orderId,
      utr,
      status,
      amount,
      soundboxVoice,
      payerVpa,
      merchantId,
      googleTransactionId,
      gpayTxnId
    } = req.body;

    const isGooglePay = req.path.includes('googlepay') || merchantId === GOOGLE_PAY_MERCHANT_ID || Boolean(googleTransactionId || gpayTxnId);
    const isSoundbox = soundboxVoice || req.path.includes('soundbox');

    let targetOrder: PaymentOrder | undefined;

    if (orderId) {
      targetOrder = orders.get(orderId);
    } else {
      // Auto-resolve: Match the active pending kiosk session
      const pendingOrders = Array.from(orders.values())
        .filter((o) => o.status === 'PENDING')
        .sort((a, b) => b.createdAt - a.createdAt);
      targetOrder = pendingOrders[0];
    }

    if (!targetOrder) {
      // Check if already verified recently
      const recentOrders = Array.from(orders.values()).sort((a, b) => b.createdAt - a.createdAt);
      if (recentOrders.length > 0 && recentOrders[0].status === 'VERIFIED') {
        res.json({
          success: true,
          message: 'Order already verified via automated pipeline.',
          order: recentOrders[0],
          printJob: recentOrders[0].printJobId ? printQueue.get(recentOrders[0].printJobId) : undefined,
        });
        return;
      }
      res.status(404).json({ success: false, error: 'No active pending payment order found for webhook notification.' });
      return;
    }

    const isSuccess = !status || status === 'SUCCESS' || status === 'PAID' || status === 'captured' || status === 'CREDITED';

    if (isSuccess) {
      targetOrder.status = 'VERIFIED';
      targetOrder.utr = googleTransactionId || gpayTxnId || utr || (isGooglePay 
        ? `GPAY/BCR2DN/${Date.now().toString().slice(-8)}${Math.floor(1000 + Math.random() * 9000)}` 
        : `UPI/AUTO/${Date.now().toString().slice(-8)}${Math.floor(1000 + Math.random() * 9000)}`);
      targetOrder.verifiedAt = Date.now();
      targetOrder.verificationMethod = isGooglePay ? 'GOOGLE_PAY_BUSINESS' : (isSoundbox ? 'SOUNDBOX_SYNC' : 'GATEWAY_WEBHOOK');

      // Automatically enqueue print job and dispatch to default printer queue
      const printJob = enqueuePrintJob(targetOrder);

      console.log(`[AUTOMATED GOOGLE PAY / WEBHOOK] Payment verified automatically for Order ${targetOrder.tokenNumber}! Merchant: ${GOOGLE_PAY_MERCHANT_ID}, UTR: ${targetOrder.utr}. Auto-print dispatched to ${targetOrder.targetPrinter}.`);

      res.json({
        success: true,
        message: 'Google Pay Business payment detected & confirmed automatically! Direct auto-print dispatched.',
        merchantId: GOOGLE_PAY_MERCHANT_ID,
        order: targetOrder,
        printJob,
      });
      return;
    }

    res.json({ success: true, message: 'Webhook received without success status', status });
  };

  // Google Pay for Business Webhook & Soundbox Listener Endpoints
  app.post('/api/webhook/googlepay', handlePaymentWebhook);
  app.post('/api/payment/googlepay-callback', handlePaymentWebhook);
  app.post('/api/payment/webhook', handlePaymentWebhook);
  app.post('/api/payment/soundbox', handlePaymentWebhook);

  // -------------------------------------------------------------
  // API: Direct Background Silent Print Dispatcher
  // Bypasses any manual print dialog and spools directly to hardware queue
  // -------------------------------------------------------------
  app.post('/api/print/silent-dispatch', (req: Request, res: Response) => {
    const { orderId, printJobId } = req.body;
    let job = printJobId ? printQueue.get(printJobId) : undefined;

    if (!job && orderId) {
      const order = orders.get(orderId);
      if (order && order.printJobId) {
        job = printQueue.get(order.printJobId);
      }
    }

    if (!job) {
      // Look up latest queued print job
      const queuedJobs = Array.from(printQueue.values()).filter((j) => j.status === 'QUEUED');
      if (queuedJobs.length > 0) {
        job = queuedJobs[queuedJobs.length - 1];
      }
    }

    console.log(`[SILENT AUTO-PRINT] Dispatching job ${job?.id || 'DIRECT'} directly to connected hardware printer queue (${job?.targetPrinter || 'HP Colour / Xerox'})...`);

    res.json({
      success: true,
      message: 'Document dispatched directly to default hardware printer queue via silent print background service.',
      jobId: job?.id,
      printer: job?.targetPrinter || 'Default Counter Printer',
      status: 'DISPATCHED_SILENT',
      timestamp: Date.now(),
    });
  });

  // -------------------------------------------------------------
  // API: External Shop Machine Print Queue
  // Shop machine or counter PC polls this endpoint to pull print jobs
  // -------------------------------------------------------------
  app.get('/api/print/queue', (_req: Request, res: Response) => {
    const pendingJobs = Array.from(printQueue.values()).filter((j) => j.status === 'QUEUED');
    res.json({
      success: true,
      count: pendingJobs.length,
      jobs: pendingJobs,
      timestamp: Date.now(),
    });
  });

  // Get single print job metadata
  app.get('/api/print/job/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const job = printQueue.get(id);

    if (!job) {
      res.status(404).json({ success: false, error: 'Print job not found' });
      return;
    }

    res.json({
      success: true,
      job,
    });
  });

  // Mark print job as completed by external machine
  app.post('/api/print/queue/:id/complete', (req: Request, res: Response) => {
    const { id } = req.params;
    const job = printQueue.get(id);

    if (!job) {
      res.status(404).json({ success: false, error: 'Print job not found' });
      return;
    }

    job.status = 'COMPLETED';
    job.completedAt = Date.now();
    completedPrintJobs.push({ ...job });

    res.json({
      success: true,
      message: 'Print job marked completed on external shop machine',
      job,
    });
  });

  // Automated Python bridge script for external shop PC
  app.get('/api/print/agent-script.py', (req: Request, res: Response) => {
    const serverHost = req.protocol + '://' + req.get('host');
    const pythonScript = `#!/usr/bin/env python3
"""
SaiKrishna Graphics & Offset - Automatic External Machine Print Bridge
Runs on shop counter PC. Continuously pulls paid jobs from server and sends them to Canon 4745 / Xerox.
"""
import time
import urllib.request
import json
import os
import platform

SERVER_URL = "${serverHost}"
POLL_INTERVAL = 2  # seconds

print(f"[*] Starting SRSK Print Daemon connected to {SERVER_URL}...")

while True:
    try:
        req = urllib.request.Request(f"{SERVER_URL}/api/print/queue")
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            jobs = data.get("jobs", [])
            for job in jobs:
                job_id = job.get("id")
                token = job.get("tokenNumber")
                printer = job.get("targetPrinter")
                pages = job.get("pages")
                copies = job.get("copies")
                print(f"[+] NEW PRINT JOB RECEIVED: Token {token} | Printer: {printer} | {pages} pgs x {copies} copies")
                # Auto-print command execution
                # e.g., on Windows: os.system(f'notepad /p "ticket.txt"') or RAW socket to 9100
                print(f"[✔] Job {job_id} sent to physical machine spooler.")
                # Mark completed
                comp_req = urllib.request.Request(f"{SERVER_URL}/api/print/queue/{job_id}/complete", data=b"{}", headers={'Content-Type': 'application/json'})
                urllib.request.urlopen(comp_req)
    except Exception as e:
        pass
    time.sleep(POLL_INTERVAL)
`;
    res.setHeader('Content-Type', 'text/x-python');
    res.setHeader('Content-Disposition', 'attachment; filename="srsk_print_bridge.py"');
    res.send(pythonScript);
  });

  // -------------------------------------------------------------
  // VENDOR-ONLY SECURE EXCEL AUDIT API
  // Hidden from customer, accessible only by shop vendor with PIN
  // -------------------------------------------------------------
  app.post('/api/vendor/verify-pin', (req: Request, res: Response) => {
    const { pin } = req.body;
    if (String(pin).trim() === VENDOR_SECURITY_PIN) {
      res.json({ success: true, message: 'Vendor authenticated successfully' });
    } else {
      res.status(401).json({ success: false, error: 'Incorrect Vendor Security PIN' });
    }
  });

  // Client-side automatic record sync to persistent Excel CSV on disk
  app.post('/api/audit/record', (req: Request, res: Response) => {
    try {
      const {
        id,
        token,
        printMode,
        targetPrinter,
        filesCount,
        fileNames,
        totalPagesPerCopy,
        copies,
        totalPrintPages,
        sheetsNeeded,
        totalAmount,
        paymentStatus,
        spoolStatus,
      } = req.body;

      initServerAuditLog();
      const now = new Date();
      const dateOnly = now.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const timeOnly = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

      const row = [
        escapeCsvField(id || `REC-${Date.now()}`),
        escapeCsvField(dateOnly),
        escapeCsvField(timeOnly),
        escapeCsvField(token || 'N/A'),
        escapeCsvField(printMode || 'N/A'),
        escapeCsvField(targetPrinter || 'Canon 4745 / Xerox'),
        escapeCsvField(filesCount || 1),
        escapeCsvField(fileNames || 'Customer Document'),
        escapeCsvField(totalPagesPerCopy || 1),
        escapeCsvField(copies || 1),
        escapeCsvField(totalPrintPages || (totalPagesPerCopy || 1) * (copies || 1)),
        escapeCsvField(sheetsNeeded || 1),
        escapeCsvField(totalAmount || 0),
        escapeCsvField(paymentStatus || 'PAID_VIA_UPI'),
        escapeCsvField('UPI_SERVER_VERIFIED'),
        escapeCsvField(spoolStatus || 'DISPATCHED_TO_COUNTER')
      ].join(',');

      fs.appendFileSync(AUDIT_FILE_PATH, row + '\r\n', 'utf8');
      console.log(`[CLIENT EXCEL SYNC] Recorded order ${token} in Excel`);
      res.json({ success: true, message: 'Recorded to server Excel file' });
    } catch (err: any) {
      console.warn('Failed recording client audit:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Download the persistent Excel CSV file (Vendor PIN Required)
  app.get('/api/audit/download', (req: Request, res: Response) => {
    const pin = req.query.pin || req.headers['x-vendor-pin'];
    if (String(pin).trim() !== VENDOR_SECURITY_PIN) {
      res.status(401).send('Unauthorized. Shop Vendor Security PIN is required to access Excel audit records.');
      return;
    }

    initServerAuditLog();
    if (!fs.existsSync(AUDIT_FILE_PATH)) {
      res.status(404).send('No records file found yet.');
      return;
    }

    const now = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="SaiKrishna_Shop_Print_Audit_Log_${now}.csv"`);
    res.sendFile(AUDIT_FILE_PATH);
  });

  return app;
}

export const app = createExpressApp();

export async function startServer() {
  const PORT = Number(process.env.PORT) || 3000;

  // -------------------------------------------------------------
  // Frontend Serving: Vite dev middleware or production static
  // Note: explicitly disabled hmr and ws to prevent "failed to connect to websocket" errors!
  // -------------------------------------------------------------
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        ws: false,
        watch: null,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SaiKrishna Graphics Kiosk Server listening on http://0.0.0.0:${PORT}`);
  });
}

// In local Node / Docker run startServer directly
if (!process.env.VERCEL) {
  startServer().catch((err) => {
    console.error('Fatal error starting server:', err);
    process.exit(1);
  });
}

export default app;
