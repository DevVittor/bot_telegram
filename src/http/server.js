import express from "express";
import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import { MongoClient } from "mongodb";
import "dotenv/config";

// Configurações
const TELEGRAM_TOKEN =
  process.env.TELEGRAM_TOKEN ||
  "7764496061:AAFujOMZ15psFdlgXt-EJO01uCLxfh4l-rk";
const MERCADOPAGO_TOKEN =
  process.env.MERCADOPAGO_TOKEN ||
  "TEST-1062389066568096-080517-dd2a8ed27546eb7650d90e53d18d183b-1159739427";
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const PORT = process.env.PORT || 3000;

// Inicialização
const app = express();
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
let db;

// Middleware para JSON
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.disable("x-powered-by");

// Conexão com MongoDB
async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    db = client.db("telegram_bot");
    console.log("Conectado ao MongoDB");
  } catch (err) {
    console.error("Erro ao conectar ao MongoDB:", err);
    process.exit(1);
  }
}

// Funções auxiliares
async function verificarAssinatura(userId) {
  const user = await db.collection("users").findOne({ user_id: userId });
  return user && user.status === "active";
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
          success: "https://www.youtube.com/watch?v=O4hqkkwxCS8",
          failure:
            "https://www.youtube.com/watch?v=I3YE9ltzebI&pp=0gcJCX4JAYcqIYzv",
          pending: "https://www.youtube.com/watch?v=MOgOAUpX1ks",
        },
        notification_url: "https://www.youtube.com/watch?v=HO-TmB4AgNM",
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
    return "https://link-de-fallback-do-mercadopago";
  }
}

// Comandos do Telegram
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const isAssinante = await verificarAssinatura(chatId);

    if (isAssinante) {
      bot.sendMessage(chatId, "✅ Você é um assinante ativo! Acesso liberado.");
    } else {
      const linkPagamento = await criarLinkPagamento(chatId);
      bot.sendMessage(
        chatId,
        `🔒 Conteúdo exclusivo para assinantes!\n\n` +
          `Para acessar, assine nosso serviço:\n` +
          `${linkPagamento}\n\n` +
          `Após o pagamento, seu acesso será liberado automaticamente.`
      );
    }
  } catch (error) {
    console.error("Erro no comando /start:", error);
    bot.sendMessage(
      chatId,
      "⚠️ Ocorreu um erro. Por favor, tente novamente mais tarde."
    );
  }
});

// Webhook do Mercado Pago
app.post("/mp-webhook", async (req, res) => {
  try {
    const paymentId = req.body.data?.id;

    if (paymentId) {
      const response = await axios.get(
        `https://api.mercadopago.com/v1/payments/${paymentId}`,
        {
          headers: {
            Authorization: `Bearer ${MERCADOPAGO_TOKEN}`,
          },
        }
      );

      const paymentData = response.data;
      const userId = paymentData.metadata?.telegram_user_id;
      const status = paymentData.status;

      if (userId && status === "approved") {
        await db.collection("users").updateOne(
          { user_id: userId },
          {
            $set: {
              mp_subscription_id: paymentId,
              status: "active",
              created_at: new Date(),
            },
          },
          { upsert: true }
        );

        bot.sendMessage(
          userId,
          "🎉 Pagamento aprovado! Seu acesso foi liberado."
        );
      }
    }

    res.status(200).json({ status: "ok" });
  } catch (error) {
    console.error("Erro no webhook:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Iniciar servidor
async function startServer() {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
  });
}

startServer();
