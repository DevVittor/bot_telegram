import express from "express";
import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import { MongoClient } from "mongodb";
import "dotenv/config";

// Configurações
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const MERCADOPAGO_TOKEN = process.env.MERCADOPAGO_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const PORT = process.env.PORT || 3000;
const RAILWAY_URL = process.env.RAILWAY_URL;

// Inicialização
const app = express();
const bot = new TelegramBot(TELEGRAM_TOKEN);
let db;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.disable("x-powered-by");

// Conexão com MongoDB
async function connectDB() {
  const client = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
  });

  try {
    await client.connect();
    db = client.db("telegram_bot");
    await db.command({ ping: 1 });
    console.log("Conectado ao MongoDB com sucesso!");
  } catch (err) {
    console.error("Falha na conexão com MongoDB:", err);
    process.exit(1);
  }
}

// Configurar Webhook do Telegram
async function setupWebhook() {
  try {
    await bot.setWebHook(`${RAILWAY_URL}/telegram-webhook`);
    console.log("Webhook configurado com sucesso!");
  } catch (err) {
    console.error("Erro ao configurar webhook:", err);
  }
}

// Funções auxiliares
async function verificarAssinatura(userId) {
  try {
    const user = await db.collection("users").findOne({ user_id: userId });
    return user && user.status === "active";
  } catch (err) {
    console.error("Erro ao verificar assinatura:", err);
    return false;
  }
}

async function criarLinkPagamento(userId) {
  try {
    const response = await axios.post(
      "https://api.mercadopago.com/checkout/preferences",
      {
        items: [
          {
            title: "Assinatura Mensal",
            quantity: 1,
            unit_price: 29.9,
            currency_id: "BRL",
          },
        ],
        back_urls: {
          success: `${RAILWAY_URL}/sucesso`,
          failure: `${RAILWAY_URL}/erro`,
          pending: `${RAILWAY_URL}/pendente`,
        },
        notification_url: `${RAILWAY_URL}/mp-webhook`,
        metadata: { telegram_user_id: userId },
      },
      {
        headers: {
          Authorization: `Bearer ${MERCADOPAGO_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    return response.data.init_point || response.data.sandbox_init_point;
  } catch (error) {
    console.error("Erro ao criar link de pagamento:", error);
    return `${RAILWAY_URL}/assinatura`;
  }
}

// Rotas
app.post("/telegram-webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.post("/mp-webhook", async (req, res) => {
  try {
    const paymentId = req.body.data?.id;

    if (!paymentId)
      return res.status(400).json({ error: "ID de pagamento ausente" });

    const response = await axios.get(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      {
        headers: {
          Authorization: `Bearer ${MERCADOPAGO_TOKEN}`,
        },
      }
    );

    const { metadata, status } = response.data;
    const userId = metadata?.telegram_user_id;

    if (userId && status === "approved") {
      await db.collection("users").updateOne(
        { user_id: userId },
        {
          $set: {
            mp_subscription_id: paymentId,
            status: "active",
            updated_at: new Date(),
          },
          $setOnInsert: {
            created_at: new Date(),
          },
        },
        { upsert: true }
      );

      await bot.sendMessage(
        userId,
        "🎉 Pagamento aprovado! Seu acesso foi liberado."
      );
    }

    res.status(200).json({ status: "ok" });
  } catch (error) {
    console.error("Erro no webhook:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Handlers do Telegram
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const isAssinante = await verificarAssinatura(chatId);
    const message = isAssinante
      ? "✅ Você é um assinante ativo! Acesso liberado."
      : `🔒 Conteúdo exclusivo para assinantes!\n\n` +
        `Para acessar, assine nosso serviço:\n` +
        `${await criarLinkPagamento(chatId)}\n\n` +
        `Após o pagamento, seu acesso será liberado automaticamente.`;

    await bot.sendMessage(chatId, message);
  } catch (error) {
    console.error("Erro no comando /start:", error);
    await bot.sendMessage(
      chatId,
      "⚠️ Ocorreu um erro. Por favor, tente novamente mais tarde."
    );
  }
});

// Health Check
app.get("/", (req, res) => {
  res.status(200).json({ status: "online", timestamp: new Date() });
});

// Inicialização
async function startServer() {
  try {
    await connectDB();
    await setupWebhook();

    app.listen(PORT, () => {
      console.log(`🚀 Servidor rodando na porta ${PORT}`);
      console.log(`🔗 Webhook: ${RAILWAY_URL}/telegram-webhook`);
      console.log(`🔗 MercadoPago Webhook: ${RAILWAY_URL}/mp-webhook`);
    });
  } catch (err) {
    console.error("Falha na inicialização:", err);
    process.exit(1);
  }
}

startServer();
