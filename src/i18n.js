export const translations = {
    en: {
        my_chats: "My Chats",
        start_new_chat: "Start New Chat",
        default_title: "Conversation",
        chat_header: "Chat",
        start_conversation: "Start of conversation",
        input_placeholder: "Type a message...",
        submit: "Submit",
        submitted: "Submitted"
    },
    es: {
        my_chats: "Mis Chats",
        start_new_chat: "Iniciar Nuevo Chat",
        default_title: "Conversación",
        chat_header: "Chat",
        start_conversation: "Inicio de la conversación",
        input_placeholder: "Escribe un mensaje...",
        submit: "Enviar",
        submitted: "Enviado"
    },
    it: {
        my_chats: "Le Mie Chat",
        start_new_chat: "Inizia Nuova Chat",
        default_title: "Conversazione",
        chat_header: "Chat",
        start_conversation: "Inizio della conversazione",
        input_placeholder: "Scrivi un messaggio...",
        submit: "Invia",
        submitted: "Inviato"
    },
    de: {
        my_chats: "Meine Chats",
        start_new_chat: "Neuen Chat starten",
        default_title: "Unterhaltung",
        chat_header: "Chat",
        start_conversation: "Beginn der Unterhaltung",
        input_placeholder: "Nachricht schreiben...",
        submit: "Senden",
        submitted: "Gesendet"
    },
    cs: {
        my_chats: "Moje Konverzace",
        start_new_chat: "Zahájit nový chat",
        default_title: "Konverzace",
        chat_header: "Chat",
        start_conversation: "Začátek konverzace",
        input_placeholder: "Napište zprávu...",
        submit: "Odeslat",
        submitted: "Odesláno"
    },
    sk: {
        my_chats: "Moje Konverzácie",
        start_new_chat: "Začať nový chat",
        default_title: "Konverzácia",
        chat_header: "Chat",
        start_conversation: "Začiatok konverzácie",
        input_placeholder: "Napíšte správu...",
        submit: "Odoslať",
        submitted: "Odoslané"
    }
};

export class Localization {
    constructor(lang = 'en') {
        this.lang = lang;
        if (!translations[this.lang]) {
            console.warn(`Language '${lang}' not supported, falling back to 'en'.`);
            this.lang = 'en';
        }
    }

    t(key) {
        return translations[this.lang][key] || translations['en'][key] || key;
    }
}
