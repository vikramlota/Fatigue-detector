import { NavLink, Route, Routes, useParams } from "react-router-dom";
import UserList from "./views/UserList.jsx";
import UserDetail from "./views/UserDetail.jsx";
import Export from "./views/Export.jsx";

export default function App() {
  return (
    <div className="app">
      <aside className="sidebar">
        <h1>Helix Clinic</h1>
        <nav>
          <NavLink to="/" end>
            Users
          </NavLink>
          <NavLink to="/export">Export</NavLink>
        </nav>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/" element={<UserList />} />
          <Route path="/user/:hash" element={<UserDetail />} />
          <Route path="/user/:hash/export" element={<ExportWrapper />} />
          <Route path="/export" element={<ExportIndex />} />
        </Routes>
      </main>
    </div>
  );
}

function ExportWrapper() {
  const { hash } = useParams();
  return <Export hash={hash} />;
}

function ExportIndex() {
  return (
    <div className="card">
      <h2>Export</h2>
      <p>Select a user from the Users list, then use the Export buttons on their detail page.</p>
    </div>
  );
}
