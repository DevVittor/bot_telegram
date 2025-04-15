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
const SEU_CHAT_ID = process.env.SEU_CHAT_ID;
const GRUPO_ID = process.env.GRUPO_ID;
const SEU_WHATSAPP = process.env.ZAP;
const IS_SANDBOX = process.env.NODE_ENV !== "production"; // Sandbox por padrão, a menos que seja produção

// Inicialização
const app = express();
const bot = new TelegramBot(TELEGRAM_TOKEN);
let db;

// Objeto para armazenar formulários em andamento
const formulariosPendentes = new Map();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.disable("x-powered-by");

// Conexão com MongoDB com retry
async function connectDB() {
  const client = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
  });

  let retries = 3;
  while (retries) {
    try {
      await client.connect();
      db = client.db("telegram_bot");
      await db.command({ ping: 1 });
      console.log("Conectado ao MongoDB com sucesso!");
      return;
    } catch (err) {
      console.error(
        `Falha na conexão com MongoDB (tentativa ${4 - retries}):`,
        err
      );
      retries -= 1;
      if (retries === 0) {
        console.error("Não foi possível conectar ao MongoDB.");
        process.exit(1);
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

// Configurar Webhook do Telegram
async function setupWebhook() {
  try {
    const webhookUrl = `${RAILWAY_URL}/telegram-webhook`;
    console.log(`Configurando webhook para: ${webhookUrl}`);
    await bot.setWebHook(webhookUrl);
    console.log("Webhook configurado com sucesso!");
  } catch (err) {
    console.error("Erro ao configurar webhook:", err);
    throw err;
  }
}

// Função para gerar link do WhatsApp
async function enviarParaWhatsApp(dados) {
  try {
    const mensagem =
      `✅ NOVO ASSINANTE\n\n` +
      `Nome: ${dados.nome}\n` +
      `Email: ${dados.email}\n` +
      `Telefone: ${dados.telefone}\n` +
      `ID Telegram: ${dados.userId}\n` +
      `ID Pagamento: ${dados.paymentId || "N/A"}`;

    const linkWhatsApp = `https://wa.me/${SEU_WHATSAPP}?text=${encodeURIComponent(
      mensagem
    )}`;
    await bot.sendMessage(
      SEU_CHAT_ID,
      `📤 Clique para enviar dados ao WhatsApp:\n${linkWhatsApp}`
    );
    return true;
  } catch (error) {
    console.error("Erro ao gerar link WhatsApp:", error.message);
    return false;
  }
}

// Funções auxiliares
async function verificarAssinatura(userId) {
  try {
    const user = await db.collection("users").findOne({ user_id: userId });
    return user && user.status === "active";
  } catch (err) {
    console.error("Erro ao verificar assinatura:", err.message);
    return false;
  }
}

async function criarLinkPagamento(userId, dadosFormulario) {
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
        metadata: {
          telegram_user_id: userId,
          nome: dadosFormulario.nome,
          email: dadosFormulario.email,
          telefone: dadosFormulario.telefone,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${MERCADOPAGO_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    // Retorna o link apropriado com base no ambiente
    return IS_SANDBOX
      ? response.data.sandbox_init_point
      : response.data.init_point;
  } catch (error) {
    console.error("Erro ao criar link de pagamento:", error.message);
    throw error;
  }
}

// Função para validar e-mail
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// Função para validar telefone (simples, aceita formatos com DDD)
function isValidPhone(phone) {
  const phoneRegex = /^\+?\d{10,15}$/;
  return phoneRegex.test(phone.replace(/\D/g, ""));
}

// Função para enviar formulário
async function enviarFormulario(chatId) {
  return new Promise(async (resolve, reject) => {
    if (formulariosPendentes.has(chatId)) {
      await bot.sendMessage(
        chatId,
        "ℹ️ Você já tem um formulário em andamento."
      );
      return reject(new Error("Formulário já em andamento"));
    }

    const formulario = {
      etapa: 1,
      dados: {},
      listener: null,
    };

    formulariosPendentes.set(chatId, formulario);

    const timeout = setTimeout(() => {
      if (formulario.listener) {
        bot.removeListener("message", formulario.listener);
      }
      formulariosPendentes.delete(chatId);
      bot.sendMessage(chatId, "⌛ Tempo expirado. Use /start para recomeçar.");
      reject(new Error("Tempo expirado"));
    }, 300000); // Reduzido para 5 minutos

    formulario.listener = async (msg) => {
      if (msg.chat.id !== chatId || msg.text.startsWith("/")) return;

      try {
        const formularioAtual = formulariosPendentes.get(chatId);
        if (!formularioAtual) return;

        switch (formularioAtual.etapa) {
          case 1:
            formularioAtual.dados.nome = msg.text.trim();
            formularioAtual.etapa = 2;
            await bot.sendMessage(chatId, "2. Qual seu e-mail?");
            break;

          case 2:
            if (!isValidEmail(msg.text)) {
              await bot.sendMessage(
                chatId,
                "❌ Por favor, digite um e-mail válido:"
              );
              return;
            }
            formularioAtual.dados.email = msg.text.trim();
            formularioAtual.etapa = 3;
            await bot.sendMessage(
              chatId,
              "3. Qual seu telefone com DDD? (Ex.: +5511999999999)"
            );
            break;

          case 3:
            if (!isValidPhone(msg.text)) {
              await bot.sendMessage(
                chatId,
                "❌ Por favor, digite um telefone válido:"
              );
              return;
            }
            formularioAtual.dados.telefone = msg.text.trim();

            await db.collection("formularios").insertOne({
              user_id: chatId,
              ...formularioAtual.dados,
              data_preenchimento: new Date(),
            });

            clearTimeout(timeout);
            bot.removeListener("message", formularioAtual.listener);
            formulariosPendentes.delete(chatId);
            resolve(formularioAtual.dados);
            break;
        }
      } catch (error) {
        clearTimeout(timeout);
        if (formulario.listener) {
          bot.removeListener("message", formulario.listener);
        }
        formulariosPendentes.delete(chatId);
        reject(error);
      }
    };

    bot.on("message", formulario.listener);

    try {
      await bot.sendMessage(chatId, "📝 Precisamos de algumas informações:");
      await bot.sendMessage(chatId, "1. Qual seu nome completo?");
    } catch (error) {
      clearTimeout(timeout);
      if (formulario.listener) {
        bot.removeListener("message", formulario.listener);
      }
      formulariosPendentes.delete(chatId);
      reject(error);
    }
  });
}

// Rotas
app.post("/telegram-webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.post("/mp-webhook", async (req, res) => {
  try {
    const { type, data } = req.body;
    if (type !== "payment" || !data?.id) {
      return res.status(200).json({ status: "ignored" });
    }

    const paymentId = data.id;

    // Verifica se o pagamento já foi processado
    const existingPayment = await db
      .collection("payments")
      .findOne({ payment_id: paymentId });
    if (existingPayment) {
      return res.status(200).json({ status: "already_processed" });
    }

    const response = await axios.get(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      { headers: { Authorization: `Bearer ${MERCADOPAGO_TOKEN}` } }
    );

    const { metadata, status } = response.data;
    const userId = metadata?.telegram_user_id;

    if (userId && status === "approved") {
      // Salva o pagamento para evitar duplicatas
      await db.collection("payments").insertOne({
        payment_id: paymentId,
        user_id: userId,
        status: "approved",
        created_at: new Date(),
      });

      // Atualiza o banco de dados
      await db.collection("users").updateOne(
        { user_id: userId },
        {
          $set: {
            mp_subscription_id: paymentId,
            status: "active",
            updated_at: new Date(),
            nome: metadata.nome,
            email: metadata.email,
            telefone: metadata.telefone,
          },
          $setOnInsert: {
            created_at: new Date(),
          },
        },
        { upsert: true }
      );

      // Envia para o WhatsApp
      await enviarParaWhatsApp({
        nome: metadata.nome,
        email: metadata.email,
        telefone: metadata.telefone,
        userId: userId,
        paymentId: paymentId,
      });

      // Notifica o usuário
      await bot.sendMessage(
        userId,
        "🎉 Pagamento aprovado! Você será adicionado ao grupo em instantes."
      );

      // Tenta adicionar ao grupo
      try {
        await bot.inviteChatMember(GRUPO_ID, userId); // Atualizado para inviteChatMember

        // Mensagem de boas-vindas no grupo
        await bot.sendMessage(
          GRUPO_ID,
          `👋 Bem-vindo ${metadata.nome || "novo membro"} ao grupo!`
        );

        // Mensagem para o usuário
        await bot.sendMessage(
          userId,
          `✅ Você foi adicionado ao grupo com sucesso!`
        );
      } catch (error) {
        console.error("Erro ao adicionar ao grupo:", error.message);

        // Cria um link de convite único
        const inviteLink = await bot.createChatInviteLink(GRUPO_ID, {
          member_limit: 1,
          name: `Convite para ${metadata.nome || userId}`,
          creates_join_request: false,
        });

        await bot.sendMessage(
          userId,
          `🔗 Clique neste link para entrar no grupo:\n${inviteLink.invite_link}\n\n` +
            `Este link é válido apenas para você e expira após 1 uso.`
        );
      }
    }

    res.status(200).json({ status: "ok" });
  } catch (error) {
    console.error("Erro no webhook:", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Handlers do Telegram
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const isAssinante = await verificarAssinatura(chatId);

    if (isAssinante) {
      await bot.sendMessage(
        chatId,
        "✅ Você já é um assinante ativo! Acesso liberado."
      );
      return;
    }

    try {
      await bot.sendMessage(
        chatId,
        "Vamos precisar de algumas informações antes de gerar seu link de pagamento..."
      );

      const dadosFormulario = await enviarFormulario(chatId);
      const linkPagamento = await criarLinkPagamento(chatId, dadosFormulario);

      await bot.sendMessage(
        chatId,
        `🔗 Aqui está seu link de pagamento:\n${linkPagamento}\n\n` +
          `Após o pagamento, você será adicionado automaticamente ao grupo.`
      );
    } catch (error) {
      console.error("Erro no formulário:", error.message);
      await bot.sendMessage(
        chatId,
        "⚠️ Ocorreu um erro. Por favor, comece novamente com /start."
      );
    }
  } catch (error) {
    console.error("Erro no comando /start:", error.message);
    await bot.sendMessage(
      chatId,
      "⚠️ Ocorreu um erro. Tente novamente mais tarde."
    );
  }
});

// Health Check
app.get("/", (req, res) => {
  res.status(200).json({
    status: "online",
    timestamp: new Date(),
    formularios_ativos: formulariosPendentes.size,
  });
});

// Inicialização
async function startServer() {
  try {
    console.log("Iniciando servidor...");

    if (
      !TELEGRAM_TOKEN ||
      !MERCADOPAGO_TOKEN ||
      !MONGODB_URI ||
      !SEU_CHAT_ID ||
      !GRUPO_ID ||
      !SEU_WHATSAPP
    ) {
      throw new Error("Variáveis de ambiente faltando!");
    }

    // Valida se o Access Token é de teste no Sandbox
    if (IS_SANDBOX && !MERCADOPAGO_TOKEN.startsWith("TEST-")) {
      throw new Error("No modo Sandbox, use um Access Token de teste (TEST-).");
    }

    await connectDB();
    await setupWebhook();

    app.listen(PORT, () => {
      console.log(`🚀 Servidor rodando na porta ${PORT}`);
      console.log(`🔗 Webhook Telegram: ${RAILWAY_URL}/telegram-webhook`);
      console.log(`🔗 Webhook Mercado Pago: ${RAILWAY_URL}/mp-webhook`);
    });
  } catch (err) {
    console.error("Falha na inicialização:", err.message);
    process.exit(1);
  }
}

startServer();
