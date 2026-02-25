import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import crypto from "crypto";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;
const db = new Database("database.sqlite");

// Encryption setup
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "default-secret-key-32-chars-long!!"; // Must be 32 chars for aes-256-cbc
const IV_LENGTH = 16;

function encrypt(text: string) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32)), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

function decrypt(text: string) {
  const textParts = text.split(":");
  const iv = Buffer.from(textParts.shift()!, "hex");
  const encryptedText = Buffer.from(textParts.join(":"), "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32)), iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

// Database initialization
db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    cpf TEXT UNIQUE NOT NULL,
    email TEXT,
    phone TEXT,
    gov_password TEXT, -- Encrypted
    status TEXT DEFAULT 'Pendente', -- 'Pendente', 'Em Preenchimento', 'Entregue', 'Malha Fina', 'Processada'
    payment_status TEXT DEFAULT 'Pendente', -- 'Pendente', 'Pago'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS checklist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER,
    item_name TEXT NOT NULL,
    is_completed INTEGER DEFAULT 0,
    FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER,
    amount REAL NOT NULL,
    date DATETIME DEFAULT CURRENT_TIMESTAMP,
    method TEXT,
    FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE
  );
`);

app.use(express.json());

// API Routes
app.get("/api/stats", (req, res) => {
  const totalClients = db.prepare("SELECT COUNT(*) as count FROM clients").get() as any;
  const delivered = db.prepare("SELECT COUNT(*) as count FROM clients WHERE status = 'Entregue' OR status = 'Processada'").get() as any;
  const pendingPayments = db.prepare("SELECT COUNT(*) as count FROM clients WHERE payment_status = 'Pendente'").get() as any;
  const malhaFina = db.prepare("SELECT COUNT(*) as count FROM clients WHERE status = 'Malha Fina'").get() as any;

  res.json({
    totalClients: totalClients.count,
    delivered: delivered.count,
    pendingPayments: pendingPayments.count,
    malhaFina: malhaFina.count
  });
});

app.get("/api/finance/stats", (req, res) => {
  const totalReceived = db.prepare("SELECT SUM(amount) as total FROM payments").get() as any;
  const pendingCount = db.prepare("SELECT COUNT(*) as count FROM clients WHERE payment_status = 'Pendente'").get() as any;
  
  // Assuming a fixed fee of 250 for pending ones for estimation
  const estimatedPending = pendingCount.count * 250;

  res.json({
    totalReceived: totalReceived.total || 0,
    pendingCount: pendingCount.count,
    estimatedPending: estimatedPending
  });
});

app.get("/api/payments", (req, res) => {
  const payments = db.prepare(`
    SELECT p.*, c.name as client_name 
    FROM payments p 
    JOIN clients c ON p.client_id = c.id 
    ORDER BY p.date DESC
  `).all();
  res.json(payments);
});

app.get("/api/clients", (req, res) => {
  const clients = db.prepare("SELECT id, name, cpf, status, payment_status FROM clients ORDER BY name ASC").all();
  res.json(clients);
});

app.post("/api/clients", (req, res) => {
  const { name, cpf, email, phone, gov_password } = req.body;
  try {
    const encryptedPassword = gov_password ? encrypt(gov_password) : null;
    const info = db.prepare("INSERT INTO clients (name, cpf, email, phone, gov_password) VALUES (?, ?, ?, ?, ?)")
      .run(name, cpf, email, phone, encryptedPassword);
    
    // Create default checklist
    const clientId = info.lastInsertRowid;
    const defaultItems = ["RG/CPF", "Comprovante de Residência", "Informe de Rendimentos", "Extratos Bancários", "Recibos Médicos/Educação"];
    const insertChecklist = db.prepare("INSERT INTO checklist_items (client_id, item_name) VALUES (?, ?)");
    for (const item of defaultItems) {
      insertChecklist.run(clientId, item);
    }

    res.json({ id: clientId });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/clients/:id", (req, res) => {
  const client = db.prepare("SELECT * FROM clients WHERE id = ?").get(req.params.id) as any;
  if (!client) return res.status(404).json({ error: "Client not found" });
  
  // Mask password but allow decryption for authorized view (simulated)
  if (client.gov_password) {
    client.has_password = true;
    delete client.gov_password; // Don't send encrypted string to client by default
  }

  const checklist = db.prepare("SELECT * FROM checklist_items WHERE client_id = ?").all(req.params.id);
  const payments = db.prepare("SELECT * FROM payments WHERE client_id = ?").all(req.params.id);

  res.json({ ...client, checklist, payments });
});

app.get("/api/clients/:id/password", (req, res) => {
  const client = db.prepare("SELECT gov_password FROM clients WHERE id = ?").get(req.params.id) as any;
  if (!client || !client.gov_password) return res.status(404).json({ error: "Password not found" });
  res.json({ password: decrypt(client.gov_password) });
});

app.patch("/api/clients/:id", (req, res) => {
  const { status, payment_status } = req.body;
  if (status) {
    db.prepare("UPDATE clients SET status = ? WHERE id = ?").run(status, req.params.id);
  }
  if (payment_status) {
    db.prepare("UPDATE clients SET payment_status = ? WHERE id = ?").run(payment_status, req.params.id);
  }
  res.json({ success: true });
});

app.post("/api/clients/:id/checklist", (req, res) => {
  const { item_id, is_completed } = req.body;
  db.prepare("UPDATE checklist_items SET is_completed = ? WHERE id = ? AND client_id = ?")
    .run(is_completed ? 1 : 0, item_id, req.params.id);
  res.json({ success: true });
});

app.post("/api/clients/:id/payments", (req, res) => {
  const { amount, method } = req.body;
  db.prepare("INSERT INTO payments (client_id, amount, method) VALUES (?, ?, ?)")
    .run(req.params.id, amount, method);
  db.prepare("UPDATE clients SET payment_status = 'Pago' WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// Vite middleware for development
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
