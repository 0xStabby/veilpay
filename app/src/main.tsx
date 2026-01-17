import './polyfills';
import { StrictMode } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { WalletProviders } from './components/WalletProviders';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <WalletProviders>
            <App />
        </WalletProviders>
    </StrictMode>
);
